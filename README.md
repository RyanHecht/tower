# tower

> Copilot Sierra Delta Kilo, you are cleared for takeoff. Monitor Tower on 133.37 for further instance orchestration.

A long-lived host process that runs `copilot --headless` plus a small WebSocket
gateway. Surfaces (CLI, web app, mobile app, Discord bot, …) connect to the
gateway over WebSocket with a static bearer token and drive Copilot agent
sessions. Each session has its own workspace directory under `workspaces/`.

```
Surfaces ── WSS + bearer ──► Gateway ──cliUrl──► copilot --headless --port 4321
                              (Node, this repo)   (the agent runtime)
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

# 3. One-time: log the daemon's isolated ~/.copilot into a GitHub account
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

JSON line-frames over WS. First message must be `hello`.

Inbound (surface → gateway):

| Type                  | Fields                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `hello`               | `token`                                                                                 |
| `session.create`      | `id`, `workspace`, `model?`, `permissionMode?`, `allow?: string[]`, `deny?: string[]`   |
| `session.resume`      | `id`, `sessionId`, `permissionMode?`, `allow?: string[]`, `deny?: string[]`             |
| `session.list`        | `id`                                                                                    |
| `session.send`        | `sessionId`, `prompt`                                                                   |
| `session.abort`       | `sessionId`                                                                             |
| `permission.reply`    | `requestId`, `decision` (`approve`/`deny`)                                              |
| `session.keepAlive`   | `id`, `sessionId`, `keepAlive` (see below)                                              |
| `session.delete`      | `id`, `sessionId` — explicit kill (frees CLI session + on-disk state)                   |
| `router.ask`          | `id`, `prompt` — natural-language session-routing request                               |

Outbound (gateway → surface):

| Type                  | Fields                                                       |
| --------------------- | ------------------------------------------------------------ |
| `ready`               | (after auth)                                                 |
| `result`              | `id`, `ok`, `data?` / `error?`                               |
| `event`               | `sessionId`, `event` (an SDK `SessionEvent`)                 |
| `permission.request`  | `requestId`, `sessionId`, `request` (SDK `PermissionRequest`)|

`permissionMode` semantics (chosen per session by the client):

- `yolo`   — auto-approve every permission request.
- `safe`   — auto-approve `read` requests; prompt the surface for everything else.
- `prompt` — relay every request to the surface (default).

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
session id, so policies (and elapsed idle time) survive gateway restarts. The
hydrate pass on boot drops policies for sessions that no longer exist on the
daemon and immediately deletes any `idle` session whose window has already
elapsed during downtime.

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
  protocol/   # @tower/protocol — shared WS message types
  gateway/    # @tower/gateway  — long-lived daemon + WS server
  tui/        # @tower/tui      — interactive terminal client
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

## Layout

```
packages/gateway/src/
  config.ts        # paths, env, defaults
  tokens.ts        # bearer token verification
  workspaces.ts    # workspace dir resolution + safety
  rules.ts         # allow/deny rule parser + matcher (kind(arg) syntax)
  permissions.ts   # yolo / safe / prompt policy + rule evaluation
  copilot.ts       # shared CopilotClient (cliUrl)
  state.ts         # persisted gateway state (router sid, keep-alive policies)
  keepAlive.ts     # per-session idle policy: default / forever / idleMs
  router.ts        # always-on natural-language router session
  server.ts        # WS server
  connection.ts    # per-WS connection state machine
  index.ts         # entry
packages/protocol/src/
  index.ts         # shared inbound/outbound WS message types
packages/tui/src/
  index.tsx        # TUI entry (OpenTUI + React)
```

## Caveats

- Bind the gateway port (`GATEWAY_PORT`) only to interfaces you trust, or put a
  TLS terminator (Caddy, nginx, Tailscale Funnel, Cloudflare Tunnel) in front
  before exposing it off the host.
- Surfaces are out of scope here — write them against the WS protocol above.
