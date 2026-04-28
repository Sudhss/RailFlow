param(
    [switch]$NoBrowser,
    [switch]$SkipInstall,
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendUrl = "http://127.0.0.1:$BackendPort"
$FrontendUrl = "http://127.0.0.1:$FrontendPort"
$RuntimeDir = Join-Path $Root ".runtime"
$LogDir = Join-Path $RuntimeDir "logs"
$PidDir = Join-Path $RuntimeDir "pids"

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null

function Write-Step {
    param([string]$Message)
    Write-Host "[RailFlow] $Message"
}

function Test-CommandAvailable {
    param([string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Test-PortOpen {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $connection
}

function Wait-HttpReady {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 700
        }
    }
    return $false
}

function Start-RailFlowProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [string]$StdOutPath,
        [string]$StdErrPath,
        [string]$PidPath
    )

    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdOutPath `
        -RedirectStandardError $StdErrPath `
        -PassThru

    Set-Content -Path $PidPath -Value $process.Id
    Write-Step "$Name started with PID $($process.Id)."
}

if (-not (Test-CommandAvailable "python")) {
    throw "Python was not found on PATH."
}

if (-not (Test-CommandAvailable "npm")) {
    throw "npm was not found on PATH."
}

if (-not $SkipInstall) {
    Write-Step "Checking backend dependencies."
    python -m pip install -r (Join-Path $Root "backend\requirements.txt") | Out-Host

    $NodeModules = Join-Path $Root "frontend\node_modules"
    if (-not (Test-Path $NodeModules)) {
        Write-Step "Installing frontend dependencies."
        Push-Location (Join-Path $Root "frontend")
        try {
            npm install | Out-Host
        }
        finally {
            Pop-Location
        }
    }
}

if (Test-PortOpen $BackendPort) {
    Write-Step "Backend port $BackendPort is already in use. Reusing existing backend."
}
else {
    Start-RailFlowProcess `
        -Name "Backend" `
        -FilePath "python" `
        -ArgumentList @("-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "$BackendPort") `
        -WorkingDirectory $Root `
        -StdOutPath (Join-Path $LogDir "backend.out.log") `
        -StdErrPath (Join-Path $LogDir "backend.err.log") `
        -PidPath (Join-Path $PidDir "backend.pid")
}

if (Test-PortOpen $FrontendPort) {
    Write-Step "Frontend port $FrontendPort is already in use. Reusing existing frontend."
}
else {
    Start-RailFlowProcess `
        -Name "Frontend" `
        -FilePath "npm.cmd" `
        -ArgumentList @("run", "dev", "--", "--port", "$FrontendPort") `
        -WorkingDirectory (Join-Path $Root "frontend") `
        -StdOutPath (Join-Path $LogDir "frontend.out.log") `
        -StdErrPath (Join-Path $LogDir "frontend.err.log") `
        -PidPath (Join-Path $PidDir "frontend.pid")
}

Write-Step "Waiting for backend at $BackendUrl/docs."
$BackendReady = Wait-HttpReady "$BackendUrl/docs"

Write-Step "Waiting for frontend at $FrontendUrl."
$FrontendReady = Wait-HttpReady $FrontendUrl

if (-not $BackendReady) {
    Write-Warning "Backend did not become ready in time. Check .runtime\logs\backend.err.log."
}

if (-not $FrontendReady) {
    Write-Warning "Frontend did not become ready in time. Check .runtime\logs\frontend.err.log."
}

Write-Host ""
Write-Host "RailFlow URLs"
Write-Host "Backend:  $BackendUrl/docs"
Write-Host "Frontend: $FrontendUrl"
Write-Host "Logs:     $LogDir"
Write-Host ""

if (-not $NoBrowser -and $FrontendReady) {
    Start-Process $FrontendUrl
}
