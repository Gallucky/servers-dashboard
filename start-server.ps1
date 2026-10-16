# Starts the Server Dashboard hidden in the background.
# Safe to run twice: exits if the dashboard is already listening.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$cfg  = Get-Content (Join-Path $PSScriptRoot 'servers.config.json') -Raw | ConvertFrom-Json
$port = [int]$cfg.port

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Dashboard already running on port $port"
    exit 0
}

# First-run setup
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) { npm install }
if (-not (Test-Path (Join-Path $PSScriptRoot 'dist\index.html'))) { npm run build }

$logDir = Join-Path $PSScriptRoot 'data\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c npm start >> "data\logs\dashboard.log" 2>&1' `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden

# Wait up to 20s for the port to open
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "Dashboard started on http://127.0.0.1:$port"
        exit 0
    }
}
Write-Host "Dashboard did not open port $port in 20s. Check data\logs\dashboard.log"
exit 1
