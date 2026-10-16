import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Status = 'running' | 'stopped' | 'external' | 'starting' | 'stopping';

type Server = {
  id: string;
  name: string;
  url: string | null;
  port: number | null;
  status: Status;
  listening: boolean;
  pid: number | null;
  uptimeSec: number | null;
  self?: boolean;
};

type Action = 'start' | 'stop' | 'restart';

const SELF_ID = '__self';

const STATUS_LABEL: Record<Status, string> = {
  running: 'Running',
  external: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
};

const fmtUptime = (s: number | null) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
};

async function api<T>(url: string, method = 'GET'): Promise<T> {
  const res = await fetch(url, { method, headers: { 'X-Dashboard': '1' } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

/* ---- icons (16px, stroke follows currentColor) ---- */
const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const IconPlay = () => (
  <Icon>
    <path d="M4.5 3v10l8-5z" fill="currentColor" />
  </Icon>
);
const IconStop = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
  </Icon>
);
const IconRestart = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5V5h-2.5" />
  </Icon>
);
const IconLogs = () => (
  <Icon>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </Icon>
);
const IconOpen = () => (
  <Icon>
    <path d="M9 3h4v4" />
    <path d="M13 3 7.5 8.5" />
    <path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
  </Icon>
);
const IconClose = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
const Spinner = () => (
  <svg className="spin" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
    <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [busy, setBusy] = useState<Record<string, Action | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);

  // Uptime is sampled every poll; between polls the browser adds the elapsed seconds
  // so the counter ticks every second.
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const list = await api<Server[]>('/api/servers');
      setServers(list);
      setFetchedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const act = async (id: string, action: Action) => {
    setError(null);
    setBusy((b) => ({ ...b, [id]: action }));
    try {
      await api(`/api/servers/${id}/${action}`, 'POST');
    } catch (e) {
      setError(`${id}: ${(e as Error).message}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
      refresh();
    }
  };

  const managed = servers.filter((s) => !s.self);
  const ordered = [...managed, ...servers.filter((s) => s.self)]; // the dashboard's own row goes last
  const up = managed.filter((s) => s.status === 'running' || s.status === 'external').length;

  return (
    <main>
      <header>
        <h1>Servers</h1>
        <span className="count">
          {up} of {managed.length} running
        </span>
      </header>

      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss error">
            <IconClose />
          </button>
        </div>
      )}

      <div className="list">
        {ordered.map((s) => {
          const isSelf = !!s.self;
          const b = busy[s.id];
          const transitioning = s.status === 'starting' || s.status === 'stopping';
          // amber = starting/stopping, green = running (incl. external), red = stopped
          const tone = b || transitioning ? 'busy' : s.status === 'stopped' ? 'off' : 'on';
          const uptime =
            s.uptimeSec == null
              ? null
              : s.uptimeSec + Math.max(0, Math.floor((now - fetchedAt) / 1000));
          const canStart = !b && s.status === 'stopped';
          const canStop = !b && s.status !== 'stopped' && s.status !== 'stopping';
          const canRestart = !b && s.status !== 'stopping' && s.status !== 'starting';

          return (
            <section key={s.id} className={isSelf ? 'row self' : 'row'}>
              <div className="who">
                <span className={`led ${tone}`} aria-hidden="true" />
                <div className="name">
                  <h2 title={s.name}>{s.name}</h2>
                  <span
                    className={`state ${tone}`}
                    title={
                      s.status === 'external'
                        ? 'Running, but it was started outside the dashboard'
                        : undefined
                    }
                  >
                    {STATUS_LABEL[s.status]}
                    {s.status === 'external' && <span className="note"> (external)</span>}
                  </span>
                </div>
              </div>

              <dl className="stats">
                <div>
                  <dt>Port</dt>
                  <dd>{s.port ?? '—'}</dd>
                </div>
                <div>
                  <dt>PID</dt>
                  <dd>{s.pid ?? '—'}</dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{fmtUptime(uptime)}</dd>
                </div>
              </dl>

              <div className="controls">
                {!isSelf && (
                  <div className="seg" role="group" aria-label={`${s.name} controls`}>
                    <button
                      className="seg-btn start"
                      disabled={!canStart}
                      onClick={() => act(s.id, 'start')}
                      aria-busy={b === 'start'}
                    >
                      {b === 'start' ? <Spinner /> : <IconPlay />}
                      <span>Start</span>
                    </button>
                    <button
                      className="seg-btn stop"
                      disabled={!canStop}
                      onClick={() => act(s.id, 'stop')}
                      aria-busy={b === 'stop'}
                    >
                      {b === 'stop' ? <Spinner /> : <IconStop />}
                      <span>Stop</span>
                    </button>
                    <button
                      className="seg-btn restart"
                      disabled={!canRestart}
                      onClick={() => act(s.id, 'restart')}
                      aria-busy={b === 'restart'}
                    >
                      {b === 'restart' ? <Spinner /> : <IconRestart />}
                      <span>Restart</span>
                    </button>
                  </div>
                )}
                <div className="links">
                  <button className="quiet" onClick={() => setLogFor(s.id)}>
                    <IconLogs />
                    <span>Logs</span>
                  </button>
                  {s.url && (
                    <a className="quiet" href={s.url} target="_blank" rel="noreferrer">
                      <IconOpen />
                      <span>Open</span>
                    </a>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {logFor && (
        <LogPanel
          id={logFor}
          name={servers.find((s) => s.id === logFor)?.name ?? logFor}
          onClose={() => setLogFor(null)}
        />
      )}
    </main>
  );
}

function LogPanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [log, setLog] = useState('');
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const base = id === SELF_ID ? '/api/self' : `/api/servers/${id}`;
        const r = await api<{ log: string }>(`${base}/logs?lines=300`);
        if (alive) setLog(r.log.replace(/^\s+/, ''));
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [log]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" role="dialog" aria-label={`${name} logs`} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{name}</h2>
          <span className="panel-sub">Logs</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close logs">
            <IconClose />
          </button>
        </div>
        <pre ref={ref}>{log || 'No output yet.'}</pre>
      </div>
    </div>
  );
}
