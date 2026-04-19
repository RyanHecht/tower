# tower

> Copilot Sierra Delta Kilo, you are cleared for takeoff. Monitor Tower on 133.37 for further instance orchestration.

A long-lived host process that runs `copilot --headless` plus a small gateway
server. Surfaces (TUI, web app, mobile app, Discord bot, …) connect to the
gateway over WebSocket with a static bearer token and drive Copilot agent
sessions. Each session has its own workspace directory under `workspaces/`.
The gateway also serves an HTTP API on the same port for webhooks, cron
management, and health probes.

```
                          ┌─── HTTP (webhooks, crons, health)
Surfaces ── WS + bearer ──►│
                          └─── Gateway ── cliUrl ──► copilot --headless --port 4321
                                (Node, this repo)     (the agent runtime)
```

## Prereqs

- Docker (with `docker compose` v2, or `docker-compose` v1 — the scripts
  use the v2 form; swap if you're on v1).
- For the TUI: Node 20+ and `bun` on the host.

## Setup

```sh
cp .env.example .env        # tweak GATEWAY_HOST / GATEWAY_PORT if needed
npm install                 # only needed for the host-side TUI
npm run build               # typechecks the TUI / protocol
```

## Run

The Copilot daemon and the gateway run together inside one Docker container.
The daemon's `~/.copilot` lives on a named Docker volume — your host user's
`~/.copilot` is **never** touched.

```sh
# 1. Build the image (bakes in your UID/GID so bind mounts stay writable)
npm run container:build

# 2. Start the container in the background
npm run container:start

# 3. One-time auth — pick ONE of:
#   (a) Pass through your existing GitHub auth (auto-extracted from
#       `gh auth token` if present, or set COPILOT_GITHUB_TOKEN /
#       GH_TOKEN / GITHUB_TOKEN before `npm run container:start`).
#       This is the default if any token is available on the host.
#   (b) Device-flow login against the daemon's isolated ~/.copilot:
npm run container:auth

# 4. Mint at least one bearer token for surfaces to use
#    (this writes to ./data on the host, which is bind-mounted into the
#    container, so the gateway sees it immediately)
npm run token mint -- my-laptop

# 5. Point the TUI at the container's gateway (host loopback)
TOWER_URL=ws://127.0.0.1:8787 TOWER_TOKEN=<token> npm run tui
```

Stop / inspect:

```sh
npm run container:stop      # docker compose down
npm run container:status    # docker compose ps
npm run container:logs      # follow daemon + gateway logs
npm run container:shell     # debug shell inside the container
```

> If you previously ran the gateway directly on the host, stop it before
> `container:start` (else port 8787 will collide). Older `npm run daemon:*`
> scripts have been removed; the container is the only supported path now.

### Isolation

The daemon launches with `--config-dir /home/tower/.copilot` inside the
container, and that path is mounted from the named volume
`tower-copilot-home`. Concretely:

- `client.listSessions()` only ever sees daemon-managed sessions — your
  host-side interactive `copilot` sessions in `~/.copilot/sessions/` are
  invisible to the gateway.
- The daemon's GitHub auth is independent of your host user's, so you can
  attach the container to a different account.
- Bind mounts under `./data`, `./logs`, `./workspaces`, `./plugins` keep
  tokens, logs, agent file edits, and plugins inspectable from the host.

## TUI

The terminal client is an OpenTUI/React app styled after Copilot CLI. Run it
with `bun` (required — OpenTUI's `.scm` imports need Bun's import attributes):

```sh
TOWER_URL=ws://127.0.0.1:8787 TOWER_TOKEN=<token> npm run tui
```

Features:

- **Session launcher** — lists all sessions (active pinned at top); create new
  sessions or resume existing ones. Always shown on fresh launch.
- **Session view** — full conversation timeline with Markdown rendering,
  tool-call status, reasoning traces, and streaming indicators.
- **Permission prompts** — `y`/`n` dialogs for permission requests; survive
  WS disconnects and broadcast resolution to all attached subscribers.
- **Slash commands** — `/model`, `/compact`, etc. from the input prompt.
- **Status bar** — shows agent phase (thinking, streaming, reasoning, tool),
  elapsed time, bytes streamed, narrated intent, and queued-send count.
- **Keyboard** — `Esc` aborts the current turn; double `Ctrl+C` to exit.

## Session lifecycle

Sessions are long-lived and survive subscriber disconnects. When the last
WebSocket client detaches, the SDK handle stays attached to the daemon — any
in-flight turn keeps processing, and permission prompts wait for someone to
reattach and answer them. Sessions are only torn down by:

- **Explicit delete** — `session.delete` (WS)
- **Keep-alive expiry** — if an `idle` keep-alive window elapses

This is the core design principle: Tower is a daemon, not a terminal session.
The agent keeps working whether or not anyone is watching.

## Bearer tokens

Stored as sha256 hashes in `data/tokens.json`; plaintext is shown once at mint
time. Rotate by minting a new token then revoking the old one.

```sh
npm run token mint -- mobile-app
npm run token list
npm run token revoke -- <id>
```

## Workspaces

Each session runs with its `workingDirectory` rooted at `workspaces/<name>/`.
The gateway creates the directory on first use and refuses anything that would
escape the `workspaces/` root.

## Client ⇄ gateway protocol

### WebSocket

JSON line-frames over WS. First message must be `hello`.

**Inbound (surface → gateway):**

| Type                  | Fields                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `hello`               | `token`                                                                                 |
| `session.create`      | `id`, `workspace`, `model?`, `permissionMode?`, `allow?`, `deny?`, `keepAlive?`         |
| `session.resume`      | `id`, `sessionId`, `permissionMode?`, `allow?`, `deny?`, `keepAlive?`                   |
| `session.list`        | `id`                                                                                    |
| `session.listAll`     | `id` — enriched list with `isActive`, `workspace`, `summary`                            |
| `session.history`     | `id`, `sessionId` — replay all persisted events                                         |
| `session.send`        | `sessionId`, `prompt`                                                                   |
| `session.abort`       | `sessionId`                                                                             |
| `session.keepAlive`   | `id`, `sessionId`, `keepAlive`                                                          |
| `session.delete`      | `id`, `sessionId` — explicit kill (frees CLI session + on-disk state)                   |
| `permission.reply`    | `requestId`, `decision` (`approve`/`deny`)                                              |
| `router.ask`          | `id`, `prompt` — natural-language session-routing request                               |
| `router.info`         | `id` — get the router's own sessionId                                                   |
| `cron.create`         | `id`, `sessionId`, `schedule`, `prompt`                                                 |
| `cron.list`           | `id`                                                                                    |
| `cron.get`            | `id`, `cronId`                                                                          |
| `cron.update`         | `id`, `cronId`, `schedule?`, `prompt?`, `enabled?`, `sessionId?`                        |
| `cron.delete`         | `id`, `cronId`                                                                          |

SDK pass-through (all require `id`; session-scoped ones also require `sessionId`):

`models.list`, `account.quota`, `session.model.get`, `session.model.set`,
`session.mode.get`, `session.mode.set`, `session.plan.read`,
`session.plan.update`, `session.plan.delete`, `session.compact`,
`session.fleet.start`, `session.agent.list`, `session.agent.get`,
`session.agent.select`, `session.agent.deselect`.

**Outbound (gateway → surface):**

| Type                    | Fields                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `ready`                 | (after auth)                                                   |
| `result`                | `id`, `ok`, `data?` / `error?`                                 |
| `event`                 | `sessionId`, `event` (an SDK `SessionEvent`)                   |
| `permission.request`    | `requestId`, `sessionId`, `request` (SDK `PermissionRequest`)  |
| `permission.resolved`   | `requestId`, `sessionId`, `decision?`, `reason`                |
| `session.status`        | `sessionId`, `busy`, `lastIntent?`, `queuedSends`             |

### HTTP API

All HTTP routes except `/health` require `Authorization: Bearer <token>`.

| Method   | Path               | Description                                    |
| -------- | ------------------ | ---------------------------------------------- |
| `GET`    | `/health`          | Health probe (no auth)                         |
| `POST`   | `/hook/:sessionId` | Fire-and-forget prompt send (webhook ingress)  |
| `GET`    | `/crons`           | List all cron jobs                             |
| `POST`   | `/crons`           | Create a cron job                              |
| `GET`    | `/crons/:id`       | Get a cron job                                 |
| `PATCH`  | `/crons/:id`       | Update a cron job                              |
| `DELETE` | `/crons/:id`       | Delete a cron job                              |

**Webhook ingress** (`POST /hook/:sessionId`):

Send a prompt to any session without an interactive connection. Body can be
JSON `{ "prompt": "..." }` or plain text. Returns `202 Accepted` immediately
(fire-and-forget). The prompt is delivered headlessly — permission requests
during the send are auto-denied. 64KB body limit.

```sh
curl -X POST http://127.0.0.1:8787/hook/<sessionId> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "check the build status"}'
```

**Cron jobs** (`POST /crons`):

Schedule recurring prompts using standard 5-field cron expressions:

```sh
curl -X POST http://127.0.0.1:8787/crons \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "<sessionId>",
    "schedule": "0 9 * * *",
    "prompt": "good morning — check my calendar and summarize what I have today"
  }'
```

Jobs auto-disable after 5 consecutive failures (e.g., deleted session). Update
with `PATCH /crons/:id` (`{ "enabled": true }` to re-enable, which resets the
failure counter). Jobs persist across gateway restarts.

### Permission modes

`permissionMode` semantics (chosen per session by the client):

- `yolo`   — auto-approve every permission request.
- `safe`   — auto-approve container-local operations (`read`, `write`, `shell`,
  `custom-tool`); prompt the surface for `url` and `mcp` (default).
- `prompt` — relay every request to the surface.

Tower runs the agent inside a container with an isolated filesystem, so `safe`
is deliberately more permissive than Copilot CLI's built-in safe mode.

### Allow / deny rules

In addition to the mode, each session can supply explicit `allow` and `deny`
lists — a pragmatic subset of `copilot --allow-tool` / `--deny-tool` syntax:

```jsonc
{
  "type": "session.create",
  "id": 1,
  "workspace": "work-A",
  "permissionMode": "prompt",
  "allow": [
    "shell(git:*)",                  // any `git ...` command
    "shell(npm test)",               // exact match
    "write(src/*.ts)",               // glob on fileName
    "read",                          // all reads
    "url(github.com)",               // host (and subdomains) — protocol-agnostic
    "url(https://api.example.com/*)",// full URL glob (protocol-aware)
    "mcp(github)",                   // all tools from an MCP server
    "mcp(github:create_*)",          // specific tool(s) on a server
    "custom-tool(post_to_*)"         // custom tool name glob
  ],
  "deny": [
    "shell(git push)",               // override the broader allow
    "url(*malicious*)"
  ]
}
```

Evaluation order per request:

1. **deny** rules — match → `denied-by-rules` (no surface prompt).
2. **allow** rules — match → `approved`.
3. fall through to `permissionMode` (yolo / safe / prompt).

So `allow` + `deny` give you Claude-Code-style sandboxing on top of any mode.
Rules can be re-supplied on `session.resume` to update them when reattaching.

### Keep-alive

By default, the upstream CLI daemon reaps any session that's been idle (no
`session.send`) for ~30 minutes. Each session can override that with a
`keepAlive` field on `session.create` / `session.resume`, or update it later
with `session.keepAlive`:

```jsonc
"keepAlive": "default"               // upstream 30-minute reaper (default)
"keepAlive": "forever"               // never expire — only `session.delete` ends it
"keepAlive": { "idleMs": 600000 }    // 10 minutes of idle — gateway-enforced
```

Mechanics:

- For `forever` (and any `idleMs > 25min`), the gateway pings the daemon
  every 25 min by transiently re-attaching to the session — that bumps the
  upstream activity timer without injecting any user turn.
- For `idleMs`, the gateway tracks per-session activity (`session.send` from
  any client) and calls `client.deleteSession` after the window elapses.
- Activity stamps and timers persist across WS connect/disconnect — closing
  a tab or losing a phone signal does not count as inactivity.
- Send `session.keepAlive` mid-session to upgrade or downgrade the policy.
- Send `session.delete` to kill a session immediately and free its state.

The keep-alive policy persists in `data/state.json` along with the router's
session id and cron jobs, so policies (and elapsed idle time) survive gateway
restarts. The hydrate pass on boot drops policies for sessions that no longer
exist on the daemon and immediately deletes any `idle` session whose window has
already elapsed during downtime.

### Router (natural-language session lookup)

The daemon also runs a single always-on **router** session — a Copilot agent
configured as a "phone operator" — alongside the per-client sessions. Surfaces
that don't already know which session they want can ask it in plain English:

```jsonc
{ "type": "router.ask", "id": 7, "prompt": "connect me to whatever's working on the discord bot" }
```

The router sees the live list of sessions (id, workspace, summary,
last-modified) and must call exactly one of three custom tools:

- `route_to_existing(sessionId, reason)` — pick an existing session
- `route_to_new(workspace, reason)` — provision a fresh session in `workspace`
- `route_give_up(reason)` — no good match (surface should re-prompt the user)

The result frame mirrors that decision:

```jsonc
{ "type": "result", "id": 7, "ok": true, "data": {
    "action": "select", "sessionId": "abc-123", "reason": "matches your discord-bot workspace"
} }
```

Once you have the `sessionId`, follow up with `session.resume` exactly as if
you had known it from the start. The deterministic CRUD endpoints
(`session.create`, `session.resume`, `session.list`) remain the canonical API
— the router is just a convenience for clients that want to navigate by
intent. Asks are FIFO-serialized at the gateway because a single session
can't process interleaved prompts.

The router itself is sandboxed: the only tools it can invoke are the three
above (its permission handler denies everything else), so it cannot read
files, run shell commands, or hit the network on your behalf.

## Repository layout

This is an npm-workspaces monorepo:

```
packages/
  protocol/   # @tower/protocol — shared WS + HTTP message types
  gateway/    # @tower/gateway  — long-lived daemon + WS/HTTP server
  tui/        # @tower/tui      — interactive terminal client (OpenTUI + React)
scripts/      # container + token management shell scripts (run from repo root)
docker/       # entrypoint for the daemon+gateway container
data/         # tokens.json, state.json (bind-mounted into container, gitignored)
logs/         # daemon + gateway logs (bind-mounted, gitignored)
workspaces/   # per-session cwd (bind-mounted, gitignored)
plugins/      # copilot --plugin-dir (bind-mounted, gitignored)
```

Common commands (from the repo root):

```sh
npm install                  # links workspaces + installs deps
npm run build                # builds all packages
npm run typecheck            # typechecks all packages
npm run dev                  # gateway in tsx watch mode
npm start                    # gateway from compiled dist
npm run tui                  # interactive TUI client
npm run container:build|start|stop|status|logs|auth|shell
npm run token mint -- <label>
```

### Gateway source layout

```
packages/gateway/src/
  config.ts              # paths, env, defaults
  tokens.ts              # bearer token verification
  workspaces.ts          # workspace dir resolution + safety
  rules.ts               # allow/deny rule parser + matcher (kind(arg) syntax)
  permissions.ts         # yolo / safe / prompt policy + rule evaluation
  copilot.ts             # shared CopilotClient (cliUrl)
  state.ts               # persisted gateway state (router sid, keep-alive, crons)
  keepAlive.ts           # per-session idle policy: default / forever / idleMs
  router.ts              # always-on natural-language router session
  sessionAttachments.ts  # process-global session registry + multi-subscriber fanout
  attached.ts            # lightweight session-id tracker for listAll isActive
  headlessSend.ts        # send a prompt without an interactive subscriber
  crons.ts               # cron scheduler (persisted, auto-disable on failure)
  httpHandler.ts         # HTTP routes (health, webhooks, cron CRUD)
  server.ts              # HTTP + WS server (shared port)
  connection.ts          # per-WS connection handler
  index.ts               # entry
packages/protocol/src/
  index.ts               # shared inbound/outbound message types + CronJobDef
packages/tui/src/
  index.tsx              # TUI entry (OpenTUI + React)
  client.ts              # TowerClient — WS wrapper with typed events
  App.tsx                # top-level: connect → always show Launcher
  keys.ts                # key bindings + help text
  useDoubleCtrlCQuit.ts  # shared double-Ctrl+C exit hook
  views/
    Launcher.tsx         # session list + create/resume
    Session.tsx          # conversation view + status bar + input
    PermissionPrompt.tsx # y/n permission dialog
    timeline.ts          # event → timeline-entry reducer + status tracking
```

## Caveats

- Bind the gateway port (`GATEWAY_PORT`) only to interfaces you trust, or put a
  TLS terminator (Caddy, nginx, Tailscale Funnel, Cloudflare Tunnel) in front
  before exposing it off the host.
- The HTTP webhook endpoint is fire-and-forget. If the target session doesn't
  exist, the send fails silently (logged server-side). Check container logs for
  delivery failures.
- Cron jobs auto-disable after 5 consecutive failures. Re-enable with
  `PATCH /crons/:id { "enabled": true }` after fixing the underlying issue.
