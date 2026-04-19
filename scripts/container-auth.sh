#!/usr/bin/env bash
# One-time GitHub auth for the daemon's isolated ~/.copilot. Runs
# `copilot login` interactively inside the container so its tokens land on
# the tower-copilot-home named volume — never the host user's ~/.copilot.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose exec tower copilot login "$@"
