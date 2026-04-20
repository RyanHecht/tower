# syntax=docker/dockerfile:1.6
#
# Tower: copilot --headless daemon + @tower/gateway + virtual display in one
# container. The daemon runs against an isolated $COPILOT_HOME so its
# sessions/auth never mix with the host user's ~/.copilot.
#
FROM node:20-bookworm-slim

ARG UID=1000
ARG GID=1000
ARG COPILOT_VERSION=1.0.32
ARG NOVNC_VERSION=1.6.0

ENV DEBIAN_FRONTEND=noninteractive

# Runtime deps:
#   bash       — entrypoint
#   ca-certs   — TLS for npm + copilot
#   curl       — healthcheck / debug
#   netcat-openbsd — entrypoint waits for daemon port to come up
#
# Virtual display (always-on headed browser):
#   xvfb       — X virtual framebuffer (in-memory display)
#   x11vnc     — VNC server attached to Xvfb
#   fluxbox    — minimal window manager
#   xdotool    — X11 automation (click, type, window management)
#
# Browser:
#   chromium           — headed browser for web automation
#   chromium-sandbox   — Chromium's SUID sandbox helper
#   fonts-liberation   — metric-equivalent fonts for web rendering
#   fonts-noto-color-emoji — emoji support
#
# noVNC deps:
#   python3, python3-websockify — WebSocket→TCP bridge for noVNC
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl netcat-openbsd \
        xvfb x11vnc fluxbox xdotool \
        chromium chromium-sandbox fonts-liberation fonts-noto-color-emoji \
        python3 python3-websockify \
    && rm -rf /var/lib/apt/lists/*

# noVNC — browser-based VNC viewer served as static HTML+JS.
RUN curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
    | tar -xz -C /opt \
    && mv "/opt/noVNC-${NOVNC_VERSION}" /opt/noVNC \
    && ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html

# Install Copilot CLI globally. Pinned for reproducibility.
RUN npm install -g "@github/copilot@${COPILOT_VERSION}"

# Non-root user that owns /tower and $COPILOT_HOME.
# UID/GID are build args so the bind-mounted ./data, ./logs, ./workspaces
# end up owned by the host user (avoids EACCES on the host side).
# The node base image already ships a `node` user at uid/gid 1000; drop it
# first so we can claim the target ids unconditionally.
RUN if getent passwd node >/dev/null; then userdel  node;  fi \
 && if getent group  node >/dev/null; then groupdel node;  fi \
 && if getent passwd "${UID}" >/dev/null; then userdel  "$(getent passwd "${UID}" | cut -d: -f1)"; fi \
 && if getent group  "${GID}" >/dev/null; then groupdel "$(getent group  "${GID}" | cut -d: -f1)"; fi \
 && groupadd --gid "${GID}" tower \
 && useradd  --uid "${UID}" --gid "${GID}" \
             --home-dir /home/tower --create-home --shell /bin/bash tower

WORKDIR /tower

# --- deps layer ---------------------------------------------------------
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/gateway/package.json  packages/gateway/package.json
COPY packages/tui/package.json      packages/tui/package.json
RUN npm ci --include=dev

# TODO: remove this sed step once @github/copilot-sdk ships a release where
# session.{js,d.ts} import from `vscode-jsonrpc/node.js` (with the .js
# extension) under ESM. Older builds shipped `vscode-jsonrpc/node` which
# Node's strict ESM resolver rejects. The replacement is idempotent — if the
# import is already correct the pattern won't match.
RUN set -eux; \
    for f in node_modules/@github/copilot-sdk/dist/session.js \
             node_modules/@github/copilot-sdk/dist/session.d.ts; do \
        if [ -f "$f" ]; then \
            sed -i 's|"vscode-jsonrpc/node"|"vscode-jsonrpc/node.js"|g' "$f"; \
        fi; \
    done

# --- source + build -----------------------------------------------------
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY docker/entrypoint.sh /usr/local/bin/tower-entrypoint
RUN chmod +x /usr/local/bin/tower-entrypoint

RUN npm run build

# Make /tower (and the home dir) owned by the tower user so the entrypoint
# can mkdir under bind mounts at runtime.
RUN chown -R tower:tower /tower /home/tower

USER tower

ENV PROJECT_ROOT=/tower \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8787 \
    DAEMON_HOST=127.0.0.1 \
    DAEMON_PORT=4321 \
    COPILOT_HOME=/home/tower/.copilot \
    NODE_ENV=production \
    DISPLAY=:99 \
    CHROME_PATH=/usr/bin/chromium \
    CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage"

# 8787 = gateway (HTTP + WS), 6080 = noVNC (browser-based desktop viewer)
EXPOSE 8787 6080

ENTRYPOINT ["/usr/local/bin/tower-entrypoint"]
