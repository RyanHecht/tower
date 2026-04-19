#!/usr/bin/env bash
# Start the copilot --headless daemon, bound to localhost.
# Idempotent: refuses to start if a live process already owns the pid file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present
if [[ -f .env ]]; then set -a; . ./.env; set +a; fi

DAEMON_HOST="${DAEMON_HOST:-127.0.0.1}"
DAEMON_PORT="${DAEMON_PORT:-4321}"
COPILOT_BIN="${COPILOT_BIN:-copilot}"

PID_FILE="$ROOT/data/daemon.pid"
LOG_FILE="$ROOT/logs/daemon.log"
WORKSPACES="$ROOT/workspaces"
PLUGIN_DIR="$ROOT/plugins"
mkdir -p "$ROOT/data" "$ROOT/logs" "$WORKSPACES" "$PLUGIN_DIR"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "daemon already running (pid=$pid)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

echo "starting copilot daemon on $DAEMON_HOST:$DAEMON_PORT"
echo "  log:        $LOG_FILE"
echo "  workspaces: $WORKSPACES"
echo "  plugins:    $PLUGIN_DIR"

# `--headless` is the documented alias for `--server` (headless JSON-RPC).
# Bind to localhost only; the gateway is the only thing that should connect.
nohup "$COPILOT_BIN" \
  --headless \
  --port "$DAEMON_PORT" \
  --plugin-dir "$PLUGIN_DIR" \
  --add-dir "$WORKSPACES" \
  --log-dir "$ROOT/logs" \
  >> "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
sleep 0.5
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "daemon failed to start; see $LOG_FILE" >&2
  exit 1
fi
echo "daemon started (pid=$(cat "$PID_FILE"))"
