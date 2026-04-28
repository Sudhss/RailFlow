param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidDir = Join-Path $Root ".runtime\pids"

function Write-Step {
    param([string]$Message)
    Write-Host "[RailFlow] $Message"
}

function Stop-ByPidFile {
    param(
        [string]$Name,
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return
    }

    $processIdText = (Get-Content -Path $Path -Raw).Trim()
    if (-not $processIdText) {
        Remove-Item -LiteralPath $Path -Force
        return
    }

    $process = Get-Process -Id ([int]$processIdText) -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $process.Id -Force
        Write-Step "$Name stopped with PID $($process.Id)."
    }
    Remove-Item -LiteralPath $Path -Force
}

function Stop-ByPort {
    param(
        [string]$Name,
        [int]$Port
    )

    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $processIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $process.Id -Force
            Write-Step "$Name process on port $Port stopped with PID $processId."
        }
    }
}

Stop-ByPidFile -Name "Backend" -Path (Join-Path $PidDir "backend.pid")
Stop-ByPidFile -Name "Frontend" -Path (Join-Path $PidDir "frontend.pid")

Stop-ByPort -Name "Backend" -Port $BackendPort
Stop-ByPort -Name "Frontend" -Port $FrontendPort

Write-Step "Shutdown complete."
