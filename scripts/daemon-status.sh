#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
DAEMON_HOST="${DAEMON_HOST:-127.0.0.1}"
DAEMON_PORT="${DAEMON_PORT:-4321}"
PID_FILE="$ROOT/data/daemon.pid"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "daemon: running   (pid=$pid, $DAEMON_HOST:$DAEMON_PORT)"
    exit 0
  fi
  echo "daemon: stale pid  ($pid)"
  exit 1
fi
echo "daemon: stopped"
exit 1
