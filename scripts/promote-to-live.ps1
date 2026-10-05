# Pre-flight checklist before uploading Josh to the live server.
# Does NOT upload or SSH — prints what to copy and which docker builds to run on /opt/josh.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "=== Josh promote-to-live checklist ==="
Write-Host "Live stays on current images until YOU upload and rebuild on the server."
Write-Host ""

$envPath = Join-Path $Root "server\.env"
$envLocal = Join-Path $Root "server\.env.local"
$blockers = @()

if (Test-Path $envPath) {
  $envText = Get-Content $envPath -Raw
  if ($envText -match "127\.0\.0\.1|localhost:5432|josh_dev_password") {
    $blockers += "server\.env looks LOCAL (localhost / josh_dev_password). Do NOT upload it. Keep production secrets only on the server, or restore production DATABASE_URL first."
  }
  if ($envText -match "APP_BASE_URL=http://localhost") {
    $blockers += "server\.env has APP_BASE_URL=http://localhost - do not upload this .env to live."
  }
}

if (Test-Path $envLocal) {
  Write-Host "OK: server\.env.local exists (local overrides). Never upload this file."
}

if ($blockers.Count -gt 0) {
  Write-Host "BLOCKERS:" -ForegroundColor Red
  $blockers | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host ""
  exit 1
}

Write-Host "Upload to /opt/josh (exclude node_modules, docker-data, server\.env.local):"
Write-Host "  - client\"
Write-Host "  - server\   (source only; prefer NOT overwriting live server\.env)"
Write-Host "  - Caddyfile  (only if routes changed)"
Write-Host "  - docker-compose.prod.yml (only if compose changed)"
Write-Host "  - new files under server\db\migrations\  (apply SQL on live DB explicitly)"
Write-Host ""
Write-Host "On the live server after upload:"
Write-Host "  cd /opt/josh"
Write-Host "  # Client UI changes:"
Write-Host "  docker compose -f docker-compose.prod.yml build frontend"
Write-Host "  docker compose -f docker-compose.prod.yml up -d frontend"
Write-Host "  # API / server changes:"
Write-Host "  docker compose -f docker-compose.prod.yml build api"
Write-Host "  docker compose -f docker-compose.prod.yml up -d api"
Write-Host "  # Caddyfile changes:"
Write-Host "  docker compose -f docker-compose.prod.yml up -d caddy"
Write-Host ""
Write-Host "Never run: docker compose down -v   (wipes the live database volume)"
Write-Host "=== Checklist complete (no upload performed) ==="
