import express, { type Request, type Response, type NextFunction } from 'express';
import { spawn, exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

type ServerDef = {
  id: string;
  name: string;
  cwd: string;
  start: string;
  /** Optional custom stop command. Default: kill the process tree of the PID we started. */
  stop?: string;
  port?: number;
  url?: string;
  env?: Record<string, string>;
  /** Optional path of a log file the server writes itself (used for servers started outside the dashboard). */
  logFile?: string;
};
type Config = { port: number; allowedUsers: string[]; servers: ServerDef[] };
type State = Record<string, { pid: number; startedAt: number }>;

fs.mkdirSync(LOG_DIR, { recursive: true });

const config: Config = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'servers.config.json'), 'utf8'),
);
const byId = new Map(config.servers.map((s) => [s.id, s]));

let state: State = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dashboard's own event log: printed to stdout (captured to data/logs/dashboard.log by
// start-server.ps1) and kept in a ring buffer so the Logs button works regardless.
const ringBuf: string[] = [];
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ringBuf.push(line);
  if (ringBuf.length > 500) ringBuf.shift();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port: number, host = '127.0.0.1', timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function run(cmd: string, cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

function killTree(pid: number): Promise<unknown> {
  if (IS_WIN) return run(`taskkill /PID ${pid} /T /F`);
  try {
    process.kill(-pid, 'SIGTERM'); // process group
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

type Status = 'running' | 'stopped' | 'external' | 'starting' | 'stopping';

// Transitional states. 'starting' lasts until the port opens (or times out),
// 'stopping' lasts for the duration of the stop.
type Transition = { kind: 'starting' | 'stopping'; since: number };
const transitions = new Map<string, Transition>();
const START_TIMEOUT_MS = 60_000;

// When the dashboard last launched each server. Used as an uptime fallback once the
// start script has exited and the server shows up as "external". Persisted so it
// survives a dashboard restart.
const LAUNCH_FILE = path.join(DATA_DIR, 'launch.json');
const lastStart: Record<string, number> = fs.existsSync(LAUNCH_FILE)
  ? JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8'))
  : {};
const saveLaunch = () => fs.writeFileSync(LAUNCH_FILE, JSON.stringify(lastStart, null, 2));

// For servers started outside the dashboard (e.g. shell:startup), find the PID that
// owns the listening port and its uptime. Windows only. Non-blocking: returns the
// cached value immediately and refreshes it in the background every 15s.
type ExtInfo = { at: number; pid: number | null; uptimeSec: number | null };
const extCache = new Map<string, ExtInfo>();
const extInflight = new Set<string>();

function refreshExternal(s: ServerDef): Promise<void> {
  // CIM (Win32_Process) can read start time of most processes without elevation;
  // Get-Process is the fallback. PID 0/4 (System/http.sys) gets no uptime.
  const script =
    // Several processes can listen on the same port on different addresses (e.g. a
    // tailnet-IP listener from another service). Pick the one reachable on loopback:
    // loopback-specific first, then wildcard; ignore listeners bound to other IPs.
    `$c = Get-NetTCPConnection -LocalPort ${s.port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | ` +
    `Sort-Object { if ($_.LocalAddress -in @('127.0.0.1','::1')) { 0 } else { 1 } } | Select-Object -First 1; ` +
    `if ($c) { $id = $c.OwningProcess; $u = ''; ` +
    `if ($id -gt 4) { ` +
    `$w = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue; ` +
    `if ($w -and $w.CreationDate) { $u = [int]((Get-Date) - $w.CreationDate).TotalSeconds } ` +
    `else { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
    `if ($p -and $p.StartTime) { $u = [int]((Get-Date) - $p.StartTime).TotalSeconds } } } ` +
    `Write-Output ($id.ToString() + ' ' + $u) }`;
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000 },
      (_err, stdout) => {
        const [pidStr, upStr] = String(stdout ?? '').trim().split(/\s+/);
        extCache.set(s.id, {
          at: Date.now(),
          pid: pidStr ? Number(pidStr) || null : null,
          uptimeSec: upStr ? Number(upStr) : null,
        });
        resolve();
      },
    );
  });
}

function externalInfo(s: ServerDef): ExtInfo | null {
  if (!s.port || !IS_WIN) return null;
  const cached = extCache.get(s.id);
  const fresh = !!cached && Date.now() - cached.at < 15_000;
  if (!fresh && !extInflight.has(s.id)) {
    extInflight.add(s.id);
    refreshExternal(s).finally(() => extInflight.delete(s.id));
  }
  return cached ?? null;
}

async function statusOf(s: ServerDef) {
  const entry = state[s.id];
  const managedAlive = !!entry && pidAlive(entry.pid);
  if (entry && !managedAlive) {
    delete state[s.id];
    saveState();
  }
  const listening = s.port ? await portOpen(s.port) : false;

  let status: Status = 'stopped';
  const t = transitions.get(s.id);
  if (t?.kind === 'stopping') {
    status = 'stopping';
  } else if (t?.kind === 'starting') {
    const done = listening || !s.port || Date.now() - t.since > START_TIMEOUT_MS;
    if (done) transitions.delete(s.id);
    else status = 'starting';
  }
  if (status === 'stopped') {
    if (managedAlive) status = 'running';
    else if (listening) status = 'external'; // up, but not started by this dashboard
  }

  // Server is down and not mid-start: forget the old launch time.
  if (status === 'stopped' && lastStart[s.id]) {
    delete lastStart[s.id];
    saveLaunch();
  }

  const ext = status === 'external' ? externalInfo(s) : null;
  // The OS sample is cached for up to 15s; add the sample's age so uptime keeps moving forward.
  const extUptime =
    ext?.uptimeSec != null ? ext.uptimeSec + Math.floor((Date.now() - ext.at) / 1000) : null;
  const launchedUptime = lastStart[s.id] ? Math.floor((Date.now() - lastStart[s.id]) / 1000) : null;
  return {
    id: s.id,
    name: s.name,
    url: s.url ?? null,
    port: s.port ?? null,
    status,
    listening,
    pid: managedAlive ? entry!.pid : (ext?.pid ?? null),
    uptimeSec: managedAlive
      ? Math.floor((Date.now() - entry!.startedAt) / 1000)
      : status === 'external'
        ? (extUptime ?? launchedUptime)
        : null,
  };
}

async function startServer(s: ServerDef) {
  const entry = state[s.id];
  if (entry && pidAlive(entry.pid)) throw new Error('Already running');
  if (s.port && (await portOpen(s.port))) throw new Error(`Port ${s.port} already in use`);
  if (!fs.existsSync(s.cwd)) throw new Error(`cwd not found: ${s.cwd}`);

  const logPath = path.join(LOG_DIR, `${s.id}.log`);
  const fd = fs.openSync(logPath, 'a');
  fs.writeSync(fd, `\n--- start ${new Date().toISOString()} ---\n`);
  const child = spawn(s.start, {
    cwd: s.cwd,
    shell: true,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...s.env },
  });
  child.on('error', (e) => {
    fs.appendFileSync(logPath, `spawn error: ${e.message}\n`);
    transitions.delete(s.id);
  });
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) throw new Error('Failed to spawn');
  const now = Date.now();
  state[s.id] = { pid: child.pid, startedAt: now };
  saveState();
  lastStart[s.id] = now;
  saveLaunch();
  transitions.set(s.id, { kind: 'starting', since: now });
  extCache.delete(s.id);
}

async function stopServer(s: ServerDef) {
  transitions.set(s.id, { kind: 'stopping', since: Date.now() });
  try {
    if (s.stop) {
      const r = await run(s.stop, s.cwd);
      if (r.code !== 0) throw new Error(`stop command failed: ${r.out.trim().slice(0, 300)}`);
    } else {
      const entry = state[s.id];
      if (!entry) throw new Error('Not started by dashboard — define a "stop" command to control it');
      await killTree(entry.pid);
    }
    for (let i = 0; i < 20; i++) {
      const entry = state[s.id];
      const dead = !entry || !pidAlive(entry.pid);
      const closed = s.port ? !(await portOpen(s.port)) : true;
      if (dead && closed) break;
      await sleep(250);
    }
    delete state[s.id];
    saveState();
    delete lastStart[s.id];
    saveLaunch();
    extCache.delete(s.id);
  } finally {
    transitions.delete(s.id);
  }
}

function tail(file: string, lines: number): string {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  if (size === 0) return '';
  const fd = fs.openSync(file, 'r');
  // PowerShell (Out-File / Tee-Object) often writes UTF-16LE with a BOM.
  const bom = Buffer.alloc(2);
  fs.readSync(fd, bom, 0, 2, 0);
  const utf16 = bom[0] === 0xff && bom[1] === 0xfe;
  let len = Math.min(size, 128 * 1024);
  if (utf16 && (size - len) % 2 !== 0) len -= 1; // keep 2-byte alignment
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const text = buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

// ---- The dashboard itself -------------------------------------------------------
const SELF_ID = '__self';

const selfEntry = () => ({
  id: SELF_ID,
  name: 'Server Dashboard',
  url: null,
  port: config.port,
  status: 'running' as Status,
  listening: true,
  pid: process.pid,
  uptimeSec: Math.floor(process.uptime()),
  self: true,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Optional Tailscale identity allowlist (headers set by `tailscale serve`).
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (config.allowedUsers.length) {
    const user = req.header('Tailscale-User-Login');
    if (!user || !config.allowedUsers.includes(user)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }
  // CSRF guard: mutating calls need a custom header (blocks cross-site form posts).
  if (req.method !== 'GET' && req.header('X-Dashboard') !== '1') {
    res.status(400).json({ error: 'Missing X-Dashboard header' });
    return;
  }
  next();
});

app.get('/api/servers', async (_req, res) => {
  const list = await Promise.all(config.servers.map(statusOf));
  res.json([selfEntry(), ...list]);
});

app.get('/api/self/logs', (req, res) => {
  const lines = Math.min(Number(req.query.lines) || 200, 1000);
  let log = tail(path.join(LOG_DIR, 'dashboard.log'), lines);
  if (!log) log = ringBuf.slice(-lines).join('\n');
  res.json({ log: log || 'No output yet.' });
});

app.post('/api/servers/:id/:action', async (req, res) => {
  const s = byId.get(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'Unknown server' });
    return;
  }
  try {
    const action = req.params.action;
    if (action === 'start') await startServer(s);
    else if (action === 'stop') await stopServer(s);
    else if (action === 'restart') {
      await stopServer(s).catch(() => undefined);
      await startServer(s);
    } else {
      res.status(400).json({ error: 'Unknown action' });
      return;
    }
    log(`${action} ${s.id}: ok`);
    res.json(await statusOf(s));
  } catch (e) {
    log(`${req.params.action} ${s.id}: failed - ${(e as Error).message}`);
    res.status(409).json({ error: (e as Error).message });
  }
});

app.get('/api/servers/:id/logs', (req, res) => {
  const s = byId.get(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'Unknown server' });
    return;
  }
  const lines = Math.min(Number(req.query.lines) || 200, 1000);
  const file = s.logFile ?? path.join(LOG_DIR, `${s.id}.log`);
  let log = tail(file, lines);
  if (!log) {
    log = s.logFile
      ? `Log file is empty or not found:\n${s.logFile}`
      : state[s.id]
        ? 'No output yet.'
        : 'No dashboard log for this server (it was started outside the dashboard).\n' +
          'Set "logFile" in servers.config.json to a file the server writes to.';
  }
  res.json({ log });
});

app.use(express.static(path.join(ROOT, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));

// Bind to loopback only; expose with: tailscale serve --bg <port>
app.listen(config.port, '127.0.0.1', () => {
  log(`Dashboard on http://127.0.0.1:${config.port} (pid ${process.pid})`);
});
