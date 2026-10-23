param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$port = if ($env:MPS_PORT) { $env:MPS_PORT } else { '8765' }
$appHome = if ($env:MPS_HOME) { $env:MPS_HOME } else { Join-Path $HOME '.my-private-space' }
New-Item -ItemType Directory -Force -Path $appHome | Out-Null
$pidFile = Join-Path $appHome 'server.pid'
$logFile = Join-Path $appHome 'server.log'
$errorFile = Join-Path $appHome 'server-error.log'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

function Get-AppProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $pidValue = 0
  if (-not [int]::TryParse([string]$raw, [ref]$pidValue)) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; return $null }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $process) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; return $null }
  return $process
}
function Request-GracefulStop {
  try {
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
    if ($page.Content -match 'name="mps-token" content="([^"]+)"') {
      $token = $Matches[1]
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -Headers @{ 'X-MPS-Token' = $token } -TimeoutSec 3 | Out-Null
      return $true
    }
  } catch {}
  return $false
}

switch ($Action) {
  'start' {
    $existing = Get-AppProcess
    if ($existing) { Write-Output "My Private Space process is already running (PID $($existing.Id))."; exit 0 }
    $env:MPS_HOME = $appHome
    $env:MPS_PORT = $port
    $process = Start-Process -FilePath $python -ArgumentList 'run.py' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -PassThru
    Set-Content -Path $pidFile -Value $process.Id -Encoding ascii
    $ready = $false
    for ($i = 0; $i -lt 100; $i++) {
      if ($process.HasExited) { break }
      try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1 | Out-Null; $ready = $true; break } catch {}
      Start-Sleep -Milliseconds 100
    }
    if ($ready) {
      Write-Output "My Private Space is running in the background (PID $($process.Id))."
      Write-Output "The browser should open automatically. If needed, visit http://127.0.0.1:$port/"
      Write-Output "Use 'run.bat stop' to stop it or 'run.bat status' to check it."
    } else {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
      Write-Error "My Private Space did not start. Check $logFile and $errorFile."
      exit 1
    }
  }
  'status' {
    $process = Get-AppProcess
    if (-not $process) { Write-Output 'My Private Space is not running.'; exit 1 }
    Write-Output "My Private Space process is running (PID $($process.Id))."
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 | Out-Null; Write-Output "Local server is responding on port $port." } catch { Write-Output "Process exists, but the server is not responding on port $port." }
  }
  'stop' {
    $process = Get-AppProcess
    if (-not $process) { Write-Output 'My Private Space is not running.'; exit 0 }
    $null = Request-GracefulStop
    for ($i = 0; $i -lt 50; $i++) {
      if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output 'My Private Space has been stopped.'
  }
}
