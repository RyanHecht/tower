#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "daemon not running (no pid file)"
  exit 0
fi
pid="$(cat "$PID_FILE")"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "daemon not running (stale pid file)"
  rm -f "$PID_FILE"
  exit 0
fi
echo "stopping daemon (pid=$pid)"
kill "$pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$pid" 2>/dev/null; then
  echo "force killing daemon (pid=$pid)"
  kill -9 "$pid" || true
fi
rm -f "$PID_FILE"
echo "stopped"
