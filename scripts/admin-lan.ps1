# Start Studio Admin for LAN access: Next.js on :3010 + nginx reverse proxy on :8090.
# Usage: .\scripts\admin-lan.ps1
# Stop proxy: npm run admin:proxy:down

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Get-LanIPv4 {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.PrefixOrigin -ne 'WellKnown'
        } |
        Sort-Object -Property InterfaceMetric |
        Select-Object -ExpandProperty IPAddress -First 1
}

$lanIp = Get-LanIPv4
if (-not $lanIp) { $lanIp = '<your-lan-ip>' }

Write-Host ""
Write-Host "Studio Admin — LAN" -ForegroundColor Cyan
Write-Host "==================" -ForegroundColor Cyan
Write-Host ""

# Start nginx proxy (optional — skip if Docker Desktop is not running)
Write-Host "Starting nginx proxy (docker, optional)..." -ForegroundColor Yellow
docker compose -f local-admin/compose.yaml up -d --remove-orphans 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  nginx skipped (Docker not running). Use Caddy on HA or direct :3010." -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "URLs (after hosts + optional Caddy reload on HA stack):" -ForegroundColor Green
Write-Host "  Direct HTTP : http://studio-admin-konradciok.local:3010/admin  (needs hosts -> this PC)"
Write-Host "  Direct IP   : http://${lanIp}:3010/admin"
Write-Host "  Via Caddy   : https://studio-admin-konradciok.local/admin  (hosts -> 192.168.188.34, reload Caddy on HA)"
Write-Host ""
Write-Host "Optional nginx on :8090 (docker compose -f local-admin/compose.yaml up -d)"
Write-Host ""
Write-Host "Starting Next.js on 0.0.0.0:3010 (Ctrl+C stops dev server; proxy stays up)..." -ForegroundColor Yellow
Write-Host ""

npm run admin:dev:lan
