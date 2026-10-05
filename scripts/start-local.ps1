# Start local Josh stack: Docker Postgres + tip for Vite client.
# Live /opt/josh is never touched by this script.
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
  Write-Host ""
  Write-Host "Docker CLI not found. Install and start Docker Desktop, then re-run:"
  Write-Host "  https://www.docker.com/products/docker-desktop/"
  Write-Host "  npm run local:start"
  Write-Host ""
  Write-Host "Until then you can still edit code; npm run dev:server needs Postgres on 127.0.0.1:5432."
  exit 1
}

Write-Host "Using Docker: $docker"
& $docker info 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker Desktop is installed but not running. Start Docker Desktop, wait until it is ready, then re-run this script."
  exit 1
}

Write-Host "Starting local Postgres (docker-compose.yml)..."
& $docker compose -f "$Root\docker-compose.yml" up -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$envFile = Join-Path $Root "server\.env.local"
if (-not (Test-Path $envFile)) {
  Write-Host "Missing server\.env.local - create it with DATABASE_URL pointing at 127.0.0.1:5432"
  exit 1
}

Write-Host ""
Write-Host "Postgres is up. In two terminals from repo root:"
Write-Host "  npm run dev:server"
Write-Host "  npm run dev:client"
Write-Host "Then open http://localhost:5173"
Write-Host ""
Write-Host "pgAdmin (optional): http://localhost:5050"
Write-Host "  email: admin@absstem.com"
Write-Host "  password: pgadmin_dev_password"
