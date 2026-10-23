#!/usr/bin/env sh
set -eu
PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

ACTION="${1:-start}"
APP_HOME="${MPS_HOME:-$HOME/.my-private-space}"
PID_FILE="$APP_HOME/server.pid"
LOG_FILE="$APP_HOME/server.log"
PORT="${MPS_PORT:-8765}"
mkdir -p "$APP_HOME"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

case "$ACTION" in
  stop)
    if ! is_running; then
      rm -f "$PID_FILE"
      echo "My Private Space is not running."
      exit 0
    fi
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    count=0
    while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 50 ]; do sleep 0.1; count=$((count + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Server did not stop gracefully; sending termination signal again."
      kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Stop signal sent to My Private Space."
    exit 0
    ;;
  status)
    if is_running; then echo "My Private Space process is running (PID $(cat "$PID_FILE"))."; else rm -f "$PID_FILE"; echo "My Private Space is not running."; exit 1; fi
    if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then echo "Local server is responding on port $PORT."; else echo "Startup is still in progress, or the local server is not responding on port $PORT yet. Check $LOG_FILE."; fi
    exit 0
    ;;
  start) ;;
  *) echo "Usage: ./run.sh [start|stop|status]" >&2; exit 2 ;;
esac

if is_running; then
  echo "My Private Space is already starting or running (PID $(cat "$PID_FILE"))."
  echo "Use './run.sh status' to check startup, or './run.sh stop' to stop it."
  exit 0
fi
rm -f "$PID_FILE"

# Run setup and the server in a detached process. The launcher itself returns
# immediately, so a Terminal window or calling shell is not held open while
# Python dependencies are installed or while the web server runs.
nohup sh -c '
  set -eu
  cd "$1"
  if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
    .venv/bin/python -m pip install --upgrade pip
  fi
  .venv/bin/python -m pip install -r requirements.txt
  exec env MPS_HOME="$2" MPS_PORT="$3" .venv/bin/python run.py
' mps-background "$PROJECT_DIR" "$APP_HOME" "$PORT" >>"$LOG_FILE" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"
echo "My Private Space is starting in the background (PID $pid)."
echo "Setup and dependency checks will continue in the background; the browser should open when the server is ready."
echo "Use './run.sh status' to check it, './run.sh stop' to stop it, or inspect $LOG_FILE for startup errors."
