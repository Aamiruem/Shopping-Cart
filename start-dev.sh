#!/usr/bin/env bash
# Starts the API (5000), AI service (8100) and storefront (5173) - macOS / Linux / Git Bash.
# Usage (from the repo root):   ./start-dev.sh        (Windows PowerShell: .\start-dev.ps1)
# Needs PostgreSQL and MongoDB running, and each .venv / node_modules installed (see README).
# Ctrl+C stops all three.

set -u
root="$(cd "$(dirname "$0")" && pwd)"

# .venv/bin on macOS / Linux, .venv/Scripts on Windows (Git Bash)
python_in() {
  for p in "$root/$1/.venv/bin/python" "$root/$1/.venv/Scripts/python.exe"; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  echo "Missing $1/.venv - create it first (see README)" >&2
  exit 1
}

port_busy() {
  (command -v lsof >/dev/null && lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1) ||
    (command -v nc >/dev/null && nc -z 127.0.0.1 "$1" >/dev/null 2>&1)
}
for port in 5000 8100 5173; do
  port_busy "$port" && echo "Warning: port $port is already in use - stop the old server first." >&2
done

api_py="$(python_in backend)" || exit 1
ai_py="$(python_in ai-service)" || exit 1

trap 'echo; echo "Stopping..."; kill 0' INT TERM EXIT
(cd "$root/backend" && "$api_py" -m uvicorn app.main:app --reload --port 5000) &
(cd "$root/ai-service" && "$ai_py" -m uvicorn app.main:app --port 8100) &
(cd "$root/frontend" && npm run dev) &

echo "Starting... open http://localhost:5173 (API docs: http://localhost:5000/docs). Ctrl+C to stop."
wait
