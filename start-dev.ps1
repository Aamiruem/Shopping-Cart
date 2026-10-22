# Starts the API (5000), AI service (8100) and storefront (5173) in their own windows.
# Usage (from the repo root):   powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
# Needs the local PostgreSQL and MongoDB services running, and each .venv / node_modules installed (see README).

$root = $PSScriptRoot

foreach ($svc in 'MongoDB', 'postgresql*') {
    $s = Get-Service $svc -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $s) { Write-Warning "Service '$svc' not found - is it installed?" }
    elseif ($s.Status -ne 'Running') { Write-Warning "$($s.Name) is $($s.Status). Start it first (Services app or: Start-Service $($s.Name))." }
}

function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -WorkingDirectory (Join-Path $root $dir) -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$title'; $cmd"
}

Start-Window 'Veyra API :5000' 'backend' '.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 5000'
Start-Window 'Veyra AI :8100' 'ai-service' '.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8100'
Start-Window 'Veyra web :5173' 'frontend' 'npm run dev'

Write-Host 'Starting... open http://localhost:5173 (API docs: http://localhost:5000/docs)'
