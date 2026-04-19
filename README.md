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

- Node 20+
- The `copilot` CLI installed and authenticated once on the host
  (`copilot login` or `GH_TOKEN` env var).

## Setup

```sh
git init
cp .env.example .env        # tweak ports / paths if needed
npm install
npm run build
```

## Run

```sh
# 1. Start the headless Copilot daemon (bound to 127.0.0.1)
npm run daemon:start

# 2. Mint at least one bearer token for surfaces to use
npm run token mint -- my-laptop

# 3. Start the gateway
npm start                   # or: npm run dev (watch mode)
```

Stop the daemon with `npm run daemon:stop`.

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
scripts/      # daemon + token management shell scripts (run from repo root)
data/         # tokens.json, state.json, daemon.pid (gitignored)
logs/         # daemon + gateway logs (gitignored)
workspaces/   # per-session cwd (gitignored)
```

Common commands (from the repo root):

```sh
npm install                  # links workspaces + installs deps
npm run build                # builds all packages
npm run typecheck            # typechecks all packages
npm run dev                  # gateway in tsx watch mode
npm start                    # gateway from compiled dist
npm run tui                  # interactive TUI client
npm run daemon:start|stop|status
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
