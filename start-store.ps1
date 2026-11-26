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
function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -WorkingDirectory (Join-Path $root $dir) -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$title'; $cmd"
}

Start-Window 'Arvixa store API :5000' '.' 'npm run local'
Start-Window 'Arvixa web :5173' 'frontend' "`$env:VITE_STORE_MODE='store'; npm run dev"

Write-Host 'Starting... open http://localhost:5173 (admin portal: http://localhost:5173/admin/login)'
