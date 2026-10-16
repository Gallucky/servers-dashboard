# Stops the Server Dashboard (the node process listening on its port).
# Does not touch the servers it manages.
$ErrorActionPreference = 'Stop'

$cfg  = Get-Content (Join-Path $PSScriptRoot 'servers.config.json') -Raw | ConvertFrom-Json
$port = [int]$cfg.port

# Only listeners reachable on loopback, so other services (e.g. tailscaled) are never matched.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') }

if (-not $conns) {
    Write-Host 'Dashboard is not running'
    exit 0
}

foreach ($id in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
        taskkill /PID $id /T /F | Out-Null
    } else {
        Write-Host "Port $port is held by '$($proc.ProcessName)' (PID $id), not node. Not killing it."
        exit 1
    }
}

# Wait up to 10s for the port to close
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host 'Dashboard stopped'
        exit 0
    }
}
Write-Host "Port $port is still open after 10s"
exit 1
