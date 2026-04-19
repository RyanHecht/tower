#!/usr/bin/env bash
# Start the tower container in the background.
#
# Auth pass-through: if no GitHub token env var is set on the host, try to
# extract one from the gh CLI. The copilot CLI inside the container reads
# COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN (in that order) and uses it
# as its credential, bypassing the device-flow login.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${COPILOT_GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1; then
    if token="$(gh auth token 2>/dev/null)" && [[ -n "$token" ]]; then
      export COPILOT_GITHUB_TOKEN="$token"
      echo "auth: using token from \`gh auth token\` (host gh CLI)"
    fi
  fi
fi

if [[ -z "${COPILOT_GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  echo "warning: no GitHub token found on the host."
  echo "  set COPILOT_GITHUB_TOKEN (or GH_TOKEN/GITHUB_TOKEN) before starting,"
  echo "  or run \`npm run container:auth\` after start to log in via device flow."
fi

docker compose up -d "$@"
echo
echo "container started. follow logs with:  npm run container:logs"
echo "check health with:                    npm run container:status"
