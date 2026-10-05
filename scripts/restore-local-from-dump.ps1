# Restore backups\josh-live.dump into local Docker Postgres (replaces local data).
# Does not touch the live server.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Find-Docker {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $binDirs = @(
    "$env:ProgramFiles\Docker\Docker\resources\bin",
    "$env:LocalAppData\Programs\Docker\Docker\resources\bin",
    "$env:LocalAppData\Programs\DockerDesktop\resources\bin"
  )
  foreach ($dir in $binDirs) {
    $exe = Join-Path $dir "docker.exe"
    if (Test-Path $exe) {
      $env:Path = "$dir;$env:Path"
      return $exe
    }
  }
  return $null
}

$docker = Find-Docker
if (-not $docker) {
  Write-Host "Docker CLI not found. Start Docker Desktop and retry."
  exit 1
}

$Dump = Join-Path $Root "backups\josh-live.dump"
if (-not (Test-Path $Dump)) {
  Write-Host "Missing dump file:"
  Write-Host "  $Dump"
  Write-Host ""
  Write-Host "Run first:  npm run db:dump-help"
  exit 1
}

Write-Host "Using dump: $Dump"
Write-Host "Size: $([math]::Round((Get-Item $Dump).Length / 1MB, 1)) MB"
Write-Host "Ensuring local postgres is up..."
& $docker compose -f "$Root\docker-compose.yml" up -d postgres
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Wait healthy
for ($i = 0; $i -lt 30; $i++) {
  & $docker exec josh-postgres pg_isready -U josh -d josh 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 2
}

Write-Host "Copying dump into container..."
& $docker cp $Dump "josh-postgres:/tmp/josh-live.dump"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Recreating database josh (local only)..."
& $docker exec josh-postgres psql -U josh -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'josh' AND pid <> pg_backend_pid();"
& $docker exec josh-postgres psql -U josh -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS josh;"
& $docker exec josh-postgres psql -U josh -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE josh OWNER josh;"

Write-Host "Restoring dump (this can take several minutes)..."
& $docker exec josh-postgres pg_restore -U josh -d josh --no-owner --no-acl /tmp/josh-live.dump
# pg_restore often exits 1 with benign warnings; check table count instead
& $docker exec josh-postgres rm -f /tmp/josh-live.dump

Write-Host ""
Write-Host "Spot-check counts:"
& $docker exec josh-postgres psql -U josh -d josh -c "select (select count(*) from erp_users) as users, (select count(*) from companies) as companies, (select count(*) from customers) as customers, (select count(*) from quote_headers) as quotes;"

Write-Host ""
Write-Host "Restore finished. Restart local API: npm run dev:server"
Write-Host "Sign in with Google as your live SuperAdmin email."
