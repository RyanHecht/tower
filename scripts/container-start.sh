#!/usr/bin/env bash
# Start the tower container in the background.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d "$@"
echo
echo "container started. follow logs with:  npm run container:logs"
echo "check health with:                    npm run container:status"
