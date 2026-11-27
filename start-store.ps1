# Runs the store exactly as the live site does (the api/ functions: portals, CRM, seller onboarding), on an in-memory
# database with demo data. Nothing touches the live Neon database. The store API uses port 5100, so the Python backend
# (start-dev.ps1 / python main.py, port 5000) can stay running: while the store API is up, the website sends every
# /api request to it (frontend/vite.config.js).
# Usage (from the repo root):   powershell -ExecutionPolicy Bypass -File .\start-store.ps1
#
# Then open http://localhost:5173
#   Customer:  /login         asha@example.com     / secret123
#   Seller:    /seller/login  seller@example.com   / secret123
#   Admin:     /admin/login   owner@example.com    / secret123   -> the CRM and the Seller Hub admin pages
# Your own admin login too:  $env:ADMIN_EMAIL='you@gmail.com'; $env:ADMIN_PASSWORD='yourPass1'; .\start-store.ps1

$root = $PSScriptRoot
function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -WorkingDirectory (Join-Path $root $dir) -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$title'; $cmd"
}

Start-Window 'Arvixa store API :5100' '.' 'npm run local'
# The website may already be running (npm run dev in a terminal): it picks up the store API by itself
if (-not (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Window 'Arvixa web :5173' 'frontend' "`$env:VITE_STORE_MODE='store'; npm run dev"
}

Write-Host 'Starting... open http://localhost:5173 (admin portal: http://localhost:5173/admin/login)'
