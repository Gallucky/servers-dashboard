# Server Dashboard

A small web dashboard to start, stop, restart and view logs of your self-hosted servers from a browser, privately over [Tailscale](https://tailscale.com/).

## Features

- Start / stop / restart each configured server
- Live status: `running` (started by the dashboard) or `external` (port is open, but not started by it)
- Per-server log viewer
- Port-conflict checks before starting
- Process state survives dashboard restarts
- Optional lockdown to specific Tailscale users

## Tech stack

Node.js + TypeScript (server), React + Vite (web). Built for a Windows host, started through the shell.

## Prerequisites

- Windows host
- Node.js (current LTS)
- Tailscale installed and signed in

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Create your config from the example (the real config is and should be gitignored):
   ```
   copy servers.config.example.json servers.config.json
   ```
   Then edit `servers.config.json`, one entry per server (see [Configuration](#configuration)).
3. Build:
   ```
   npm run build
   ```
4. Run (listens on `127.0.0.1:4000`):
   ```
   npm start
   ```
5. Expose it to your tailnet only:
   ```
   tailscale serve --bg 4000
   ```

## Configuration

Top-level fields in `servers.config.json`:

| Field | Description |
| --- | --- |
| `port` | Required. Port the dashboard listens on (loopback only). Use `4000`, since the dev proxy in `vite.config.ts` assumes it |
| `allowedUsers` | Required, but may be an empty array `[]` to allow everyone on your tailnet. Tailscale login emails allowed to use the dashboard |
| `servers` | Array of server entries (below) |

Each entry in `servers`:

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique slug |
| `name` | yes | Display name |
| `cwd` | yes | Working directory (must exist) |
| `start` | yes | Command to launch the server (runs through the shell) |
| `stop` | no | Custom stop command. Default: kill the process tree of the PID the dashboard started |
| `port` | no | Used for status detection and port-conflict checks |
| `url` | no | Target of the "Open" link |
| `env` | no | Extra environment variables |
| `logFile` | no | Path to a log file the server writes to. Shown in the log viewer. Default: `data/logs/<id>.log` |

Use forward slashes in Windows paths (`C:/path/to/server`), or double the backslashes in JSON.

Example `start` / `stop` commands for a managed server that has its own PowerShell scripts:

```
powershell -NoProfile -ExecutionPolicy Bypass -File ./start-server.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./stop-server.ps1
```

See `servers.config.example.json` for a full example with two servers.

## How it works

- `external` status means the port is open but the dashboard didn't start the process. Controlling it requires a `stop` command.
- The log viewer reads `logFile` if set. Otherwise it falls back to `data/logs/<id>.log`. Set `logFile` when the server writes its own log (e.g. a script redirecting output), since otherwise the viewer shows the default file.
- Process state (PIDs) is stored in `data/state.json`.
- `data/` is created at runtime and is gitignored.

## Security

- The server binds to loopback only. Access goes through `tailscale serve`, which keeps it tailnet-only. Do not use Tailscale Funnel.
- Commands come only from `servers.config.json`. The UI cannot run arbitrary commands.
- `servers.config.json` contains shell commands, so treat it like code: keep it private and never make it writable from the UI.
- `allowedUsers` is checked against the `Tailscale-User-Login` header that `tailscale serve` adds. That header is only trustworthy because the app is bound to loopback behind `tailscale serve`. Do not bind it to `0.0.0.0` or put another proxy in front of it.

## Helper scripts

The two PowerShell scripts in the project root control the dashboard itself, not the servers it manages:

- `start-server.ps1`: runs `npm install` / `npm run build` on first run, then starts the dashboard hidden in the background and logs to `data\logs\dashboard.log`. Safe to run twice.
- `stop-server.ps1`: stops the `node` process listening on the dashboard's port. Refuses to kill any other process.

Both read the `port` from `servers.config.json`, so create that file first.

## Auto-start on boot

Either put a shortcut to `start-server.ps1` in your `shell:startup` folder, or use Task Scheduler to run it at logon.

## Development

Run each in its own terminal:

```
npm run dev:server
npm run dev:web
```
