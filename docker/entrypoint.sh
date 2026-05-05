#!/usr/bin/env bash
# Tower container entrypoint.
#
# Starts:
#   1. `copilot --headless` against an isolated --config-dir
#   2. The gateway in the foreground
#
# Virtual displays (Xvfb + fluxbox + x11vnc) are spawned on-demand by the
# gateway's display manager when a session needs a headed browser. The
# display stack packages are installed in the image but nothing runs at boot.
#
# A trap forwards SIGTERM/SIGINT to children before the container exits.
set -euo pipefail

: "${PROJECT_ROOT:=/tower}"
: "${COPILOT_HOME:=/home/tower/.copilot}"
: "${DAEMON_HOST:=127.0.0.1}"
: "${DAEMON_PORT:=4321}"
: "${GATEWAY_HOST:=0.0.0.0}"
: "${GATEWAY_PORT:=8787}"

mkdir -p \
    "$COPILOT_HOME" \
    "$PROJECT_ROOT/data" \
    "$PROJECT_ROOT/logs" \
    "$PROJECT_ROOT/workspaces" \
    "$PROJECT_ROOT/plugins"

DAEMON_LOG="$PROJECT_ROOT/logs/daemon.log"

# ── Copilot daemon ──────────────────────────────────────────────────────

echo "[entrypoint] starting copilot --headless on ${DAEMON_HOST}:${DAEMON_PORT}"
echo "[entrypoint]   config-dir: $COPILOT_HOME"
echo "[entrypoint]   workspaces: $PROJECT_ROOT/workspaces"
echo "[entrypoint]   plugins:    $PROJECT_ROOT/plugins"
echo "[entrypoint]   log:        $DAEMON_LOG"

copilot \
    --headless \
    --port "$DAEMON_PORT" \
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
        echo ""
        echo "╔══════════════════════════════════════════════════════════════════╗"
        echo "║              COPILOT DAEMON FAILED TO START                     ║"
        echo "╠══════════════════════════════════════════════════════════════════╣"
        echo "║                                                                 ║"
        echo "║  The daemon exited before it could listen on port $DAEMON_PORT.        ║"
        echo "║  This usually means GitHub authentication is missing or expired.║"
        echo "║                                                                 ║"
        echo "║  OPTION 1 — Device-flow login (interactive):                    ║"
        echo "║    docker exec -it tower copilot login                          ║"
        echo "║                                                                 ║"
        echo "║  OPTION 2 — Set a token in stack.env:                           ║"
        echo "║    COPILOT_GITHUB_TOKEN=<your-token>                            ║"
        echo "║    Then redeploy the stack.                                     ║"
        echo "║                                                                 ║"
        echo "║  Daemon log tail:                                               ║"
        echo "╚══════════════════════════════════════════════════════════════════╝"
        echo ""
        tail -n 50 "$DAEMON_LOG" 2>/dev/null || echo "  (log is empty)"
        echo ""
        echo "[entrypoint] waiting for auth — container will stay running."
        echo "[entrypoint] after authenticating, restart the container."
        echo ""
        # Keep the container alive so `docker exec` works.
        trap 'exit 0' TERM INT
        while true; do sleep 60; done
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
    echo ""
    echo "[entrypoint] waiting — container will stay running so you can debug."
    echo "[entrypoint] restart the container after fixing the issue."
    trap 'exit 0' TERM INT
    while true; do sleep 60; done
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
