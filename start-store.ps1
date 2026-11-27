# Runs the store exactly as the live site does (the api/ functions: portals, CRM, seller onboarding), on an in-memory
# database with demo data. Nothing touches the live Neon database. (start-dev.ps1 runs the separate Python backend,
# which doesn't have the portals or the CRM.)
# Usage (from the repo root):   powershell -ExecutionPolicy Bypass -File .\start-store.ps1
#
# Then open http://localhost:5173
#   Customer:  /login         asha@example.com     / secret123
#   Seller:    /seller/login  seller@example.com   / secret123
#   Admin:     /admin/login   owner@example.com    / secret123   -> the CRM, and More -> CRM Dashboard

$root = $PSScriptRoot

# The Python backend (start-dev.ps1) also uses port 5000. Left running, it answers /admin/login with
# "No route for POST /api/auth/admin/login", so stop it first.
foreach ($c in Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -like 'python*') {
        Write-Host "Stopping the Python backend on port 5000 (PID $($p.ProcessId))"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    } elseif ($p) {
        Write-Warning "Port 5000 is used by $($p.Name) (PID $($p.ProcessId)). Close it, then run this script again."
        return
    }
}
function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -WorkingDirectory (Join-Path $root $dir) -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$title'; $cmd"
}

Start-Window 'Arvixa store API :5000' '.' 'npm run local'
Start-Window 'Arvixa web :5173' 'frontend' "`$env:VITE_STORE_MODE='store'; npm run dev"

Write-Host 'Starting... open http://localhost:5173 (admin portal: http://localhost:5173/admin/login)'
