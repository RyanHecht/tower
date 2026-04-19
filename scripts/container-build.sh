#!/usr/bin/env bash
# Build the tower container image, baking in the host user's UID/GID so
# bind-mounted ./data, ./logs, ./workspaces are owned correctly on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose build \
    --build-arg "UID=$(id -u)" \
    --build-arg "GID=$(id -g)" "$@"
