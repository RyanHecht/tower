#!/usr/bin/env bash
# Tower container entrypoint.
#
# Starts:
#   1. Virtual display (Xvfb + fluxbox + x11vnc + noVNC) for headed browser
#   2. `copilot --headless` against an isolated --config-dir
#   3. The gateway in the foreground
#
# A trap forwards SIGTERM/SIGINT to children before the container exits.
set -euo pipefail

: "${PROJECT_ROOT:=/tower}"
: "${COPILOT_HOME:=/home/tower/.copilot}"
: "${DAEMON_HOST:=127.0.0.1}"
: "${DAEMON_PORT:=4321}"
: "${GATEWAY_HOST:=0.0.0.0}"
: "${GATEWAY_PORT:=8787}"
: "${DISPLAY:=:99}"
: "${TOWER_DISPLAY_RESOLUTION:=1280x720x24}"

mkdir -p \
    "$COPILOT_HOME" \
    "$PROJECT_ROOT/data" \
    "$PROJECT_ROOT/logs" \
    "$PROJECT_ROOT/workspaces" \
    "$PROJECT_ROOT/plugins"

DAEMON_LOG="$PROJECT_ROOT/logs/daemon.log"
DISPLAY_LOG="$PROJECT_ROOT/logs/display.log"

# ── Virtual display ─────────────────────────────────────────────────────
# Always-on headed browser environment. The agent uses DISPLAY=:99 to run
# Chromium with a real GUI — essential for avoiding bot detection.
# noVNC on port 6080 lets a human watch/interact via any browser.

echo "[entrypoint] starting virtual display on ${DISPLAY} (${TOWER_DISPLAY_RESOLUTION})"

Xvfb "${DISPLAY}" -screen 0 "${TOWER_DISPLAY_RESOLUTION}" -ac +extension GLX \
    >>"$DISPLAY_LOG" 2>&1 &
XVFB_PID=$!
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "[entrypoint] Xvfb failed to start; tail of $DISPLAY_LOG:" >&2
    tail -n 20 "$DISPLAY_LOG" >&2 || true
    exit 1
fi

fluxbox -display "${DISPLAY}" >>"$DISPLAY_LOG" 2>&1 &

x11vnc -display "${DISPLAY}" -nopw -listen 0.0.0.0 -forever -shared \
    -rfbport 5900 >>"$DISPLAY_LOG" 2>&1 &

websockify --web /opt/noVNC 0.0.0.0:6080 localhost:5900 \
    >>"$DISPLAY_LOG" 2>&1 &

echo "[entrypoint] noVNC available at http://localhost:6080"

# ── Copilot daemon ──────────────────────────────────────────────────────

echo "[entrypoint] starting copilot --headless on ${DAEMON_HOST}:${DAEMON_PORT}"
echo "[entrypoint]   config-dir: $COPILOT_HOME"
echo "[entrypoint]   workspaces: $PROJECT_ROOT/workspaces"
echo "[entrypoint]   plugins:    $PROJECT_ROOT/plugins"
echo "[entrypoint]   log:        $DAEMON_LOG"

copilot \
    --headless \
    --port "$DAEMON_PORT" \
    --config-dir "$COPILOT_HOME" \
    --plugin-dir "$PROJECT_ROOT/plugins" \
    --add-dir "$PROJECT_ROOT/workspaces" \
    --log-dir "$PROJECT_ROOT/logs" \
    >>"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

cleanup() {
    echo "[entrypoint] shutting down, killing daemon pid=$DAEMON_PID"
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
        kill -TERM "$DAEMON_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$DAEMON_PID" 2>/dev/null || break
            sleep 0.3
        done
        kill -KILL "$DAEMON_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for the daemon to listen. ~30 retries * 0.5s = 15s ceiling.
for i in $(seq 1 30); do
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "[entrypoint] daemon exited before listening; tail of $DAEMON_LOG:" >&2
        tail -n 50 "$DAEMON_LOG" >&2 || true
        exit 1
    fi
    if nc -z "$DAEMON_HOST" "$DAEMON_PORT" 2>/dev/null; then
        echo "[entrypoint] daemon up after ${i} probe(s)"
        break
    fi
    sleep 0.5
done

if ! nc -z "$DAEMON_HOST" "$DAEMON_PORT" 2>/dev/null; then
    echo "[entrypoint] daemon never came up on ${DAEMON_HOST}:${DAEMON_PORT}" >&2
    tail -n 50 "$DAEMON_LOG" >&2 || true
    exit 1
fi

echo "[entrypoint] launching gateway on ${GATEWAY_HOST}:${GATEWAY_PORT}"

node --enable-source-maps "$PROJECT_ROOT/packages/gateway/dist/index.js" &
GATEWAY_PID=$!

forward() {
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
        kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    fi
}
trap 'forward' TERM INT

wait "$GATEWAY_PID"
GATEWAY_EXIT=$?
echo "[entrypoint] gateway exited with status $GATEWAY_EXIT"
exit "$GATEWAY_EXIT"
