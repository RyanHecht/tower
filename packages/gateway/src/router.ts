import type { CopilotClient, CopilotSession, PermissionRequest, PermissionRequestResult, SessionEvent, SessionMetadata, Tool } from "@github/copilot-sdk";
import { resolveWorkspace } from "./workspaces.js";

/**
 * The "router" — a long-lived Copilot session that acts as a phone operator.
 *
 * Surfaces that don't already know which session they want can ask the router
 * in natural language ("connect me to whatever is working on the discord bot")
 * and the gateway will send the prompt into this session. The router LLM is
 * given the live list of sessions + workspaces, and must choose by calling one
 * of three custom tools we register on it:
 *
 *   - `route_to_existing(sessionId, reason)`      attach to a running session
 *   - `route_to_new(workspace, reason)`           spin up a new session
 *   - `route_give_up(reason)`                     no good match
 *
 * Asks are serialized — one outstanding prompt at a time — because a single
 * Copilot session can't handle interleaved sends.
 */

export type RouteDecision =
    | { action: "select"; sessionId: string; reason: string }
    | { action: "create"; workspace: string; reason: string; sessionId: string }
    | { action: "give_up"; reason: string };

const ROUTER_WORKSPACE = ".router";
const ROUTER_TOOL_NAMES = new Set(["route_to_existing", "route_to_new", "route_give_up"]);
const ROUTER_TIMEOUT_MS = 60_000;

const SYSTEM_INSTRUCTIONS = `
You are the "router agent" inside a long-running Copilot daemon. Surfaces
(humans on a CLI, web app, mobile app, etc.) ask you in natural language to
connect them to one of the running agent sessions on this host.

You will receive, before each user message, a JSON listing of the currently
known sessions on this host. Each entry contains the sessionId, workspace
directory, optional summary, and last-modified timestamp.

Your job, on every user turn, is to pick exactly one of these tools and call
it once:

  - route_to_existing(sessionId, reason)
       Use when an existing session matches the user's intent.
  - route_to_new(workspace, reason)
       Use when no existing session is appropriate. \`workspace\` must be a
       short, filesystem-safe name (letters, digits, dot, dash, underscore).
       The gateway will create the workspace directory and a fresh session.
  - route_give_up(reason)
       Use when the request is ambiguous, unsafe, or you cannot make a choice.
       Explain why so the surface can re-prompt the user.

Do not produce any other tool calls. Do not produce a final assistant message
without first calling one of the three tools above. Be concise in \`reason\`.
`.trim();

interface InflightAsk {
    resolve: (decision: RouteDecision) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    settled: boolean;
}

export interface RouterDeps {
    /** Snapshot of all sessions the daemon currently knows about. */
    listSessions: () => Promise<SessionMetadata[]>;
    /** Create a session in `workspace` on behalf of the router; returns its sessionId. */
    createSession: (workspace: string, reason: string) => Promise<string>;
}

export class Router {
    private session: CopilotSession | null = null;
    private inflight: InflightAsk | null = null;
    /** Serialize asks; only one prompt at a time per session. */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private client: CopilotClient, private deps: RouterDeps) {}

    /** The router's own sessionId, once `init()` has resolved. Null otherwise. */
    getSessionId(): string | null {
        return this.session?.sessionId ?? null;
    }

    async init(opts?: { resumeSessionId?: string; onSessionId?: (id: string) => void }): Promise<void> {
        const cwd = await resolveWorkspace(ROUTER_WORKSPACE);
        const tools: Tool[] = [
            {
                name: "route_to_existing",
                description: "Attach the requesting client to an existing agent session.",
                parameters: {
                    type: "object",
                    properties: {
                        sessionId: { type: "string", description: "The sessionId to attach to." },
                        reason: { type: "string", description: "One-sentence justification." },
                    },
                    required: ["sessionId", "reason"],
                    additionalProperties: false,
                },
                handler: (args: unknown) => this.settle("route_to_existing", args),
            },
            {
                name: "route_to_new",
                description: "Create a new agent session in a fresh workspace, then attach the client to it.",
                parameters: {
                    type: "object",
                    properties: {
                        workspace: { type: "string", description: "Short filesystem-safe workspace name." },
                        reason: { type: "string", description: "One-sentence justification." },
                    },
                    required: ["workspace", "reason"],
                    additionalProperties: false,
                },
                handler: (args: unknown) => this.settle("route_to_new", args),
            },
            {
                name: "route_give_up",
                description: "Return no session and explain why.",
                parameters: {
                    type: "object",
                    properties: {
                        reason: { type: "string", description: "Why no routing decision was possible." },
                    },
                    required: ["reason"],
                    additionalProperties: false,
                },
                handler: (args: unknown) => this.settle("route_give_up", args),
            },
        ];

        const sessionConfig = {
            tools,
            availableTools: Array.from(ROUTER_TOOL_NAMES),
            systemMessage: { mode: "append" as const, content: SYSTEM_INSTRUCTIONS },
            onPermissionRequest: (req: PermissionRequest) => this.permission(req),
        };

        // Try to resume the persisted router session first; fall back to a
        // fresh one if the stored sessionId is missing or no longer exists.
        if (opts?.resumeSessionId) {
            try {
                this.session = await this.client.resumeSession(opts.resumeSessionId, sessionConfig);
                console.log(`[router] resumed (sessionId=${this.session.sessionId}, cwd=${cwd})`);
            } catch (err) {
                console.log(`[router] could not resume ${opts.resumeSessionId} (${(err as Error).message}); creating fresh session`);
            }
        }
        if (!this.session) {
            this.session = await this.client.createSession({ workingDirectory: cwd, ...sessionConfig });
            console.log(`[router] ready (sessionId=${this.session.sessionId}, cwd=${cwd})`);
        }
        opts?.onSessionId?.(this.session.sessionId);

        // Belt and suspenders: if the session goes idle without a tool call,
        // reject the inflight ask with whatever the assistant said.
        this.session.on("session.idle", () => {
            if (this.inflight && !this.inflight.settled) {
                this.failInflight(new Error("router went idle without choosing a session"));
            }
        });
        this.session.on("session.error", (event: SessionEvent) => {
            const msg = (event as { data?: { message?: string } }).data?.message ?? "router session error";
            if (this.inflight && !this.inflight.settled) this.failInflight(new Error(msg));
        });
    }

    /** Ask the router. Serialized; FIFO across all callers. */
    ask(prompt: string): Promise<RouteDecision> {
        const next = this.chain.then(() => this.askInner(prompt));
        // Don't break the chain on a failure.
        this.chain = next.catch(() => undefined);
        return next;
    }

    async shutdown(): Promise<void> {
        if (this.inflight && !this.inflight.settled) this.failInflight(new Error("router shutting down"));
        if (this.session) {
            try { await this.session.disconnect(); } catch { /* ignore */ }
            this.session = null;
        }
    }

    // ── internals ──────────────────────────────────────────────────

    private async askInner(prompt: string): Promise<RouteDecision> {
        if (!this.session) throw new Error("router not initialised");
        if (this.inflight) throw new Error("router busy"); // shouldn't happen with chain serialization

        const sessions = await this.deps.listSessions();
        const visible = sessions
            .filter((s) => s.sessionId !== this.session!.sessionId) // hide the router itself
            .map((s) => ({
                sessionId: s.sessionId,
                cwd: s.context?.cwd,
                summary: s.summary ?? null,
                modifiedTime: s.modifiedTime.toISOString(),
            }));

        const wrapped = [
            "<sessions>",
            JSON.stringify(visible, null, 2),
            "</sessions>",
            "",
            "<user_request>",
            prompt,
            "</user_request>",
            "",
            "Choose now by calling exactly one of route_to_existing, route_to_new, or route_give_up.",
        ].join("\n");

        return new Promise<RouteDecision>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.failInflight(new Error(`router timed out after ${ROUTER_TIMEOUT_MS}ms`));
            }, ROUTER_TIMEOUT_MS);
            this.inflight = { resolve, reject, timer, settled: false };
            this.session!.send({ prompt: wrapped }).catch((err: Error) => {
                this.failInflight(err);
            });
        });
    }

    private permission(req: PermissionRequest): PermissionRequestResult {
        // Approve only our three custom tools. Deny everything else so the router
        // never accidentally writes files, runs shell commands, or fetches URLs.
        if (req.kind === "custom-tool" && typeof req.toolName === "string" && ROUTER_TOOL_NAMES.has(req.toolName)) {
            return { kind: "approved" };
        }
        return { kind: "denied-by-rules", rules: [] };
    }

    private async settle(toolName: string, rawArgs: unknown): Promise<string> {
        const inflight = this.inflight;
        if (!inflight || inflight.settled) {
            return "ignored: no in-flight router request";
        }

        try {
            const args = (rawArgs ?? {}) as Record<string, unknown>;
            switch (toolName) {
                case "route_to_existing": {
                    const sessionId = String(args.sessionId ?? "");
                    const reason = String(args.reason ?? "");
                    if (!sessionId) throw new Error("sessionId is required");
                    this.resolveInflight({ action: "select", sessionId, reason });
                    return `routed to ${sessionId}`;
                }
                case "route_to_new": {
                    const workspace = String(args.workspace ?? "");
                    const reason = String(args.reason ?? "");
                    if (!workspace) throw new Error("workspace is required");
                    const sessionId = await this.deps.createSession(workspace, reason);
                    this.resolveInflight({ action: "create", workspace, reason, sessionId });
                    return `created session ${sessionId} in workspace ${workspace}`;
                }
                case "route_give_up": {
                    const reason = String(args.reason ?? "no reason given");
                    this.resolveInflight({ action: "give_up", reason });
                    return `gave up: ${reason}`;
                }
                default:
                    throw new Error(`unknown router tool: ${toolName}`);
            }
        } catch (err) {
            this.failInflight(err as Error);
            throw err;
        }
    }

    private resolveInflight(decision: RouteDecision): void {
        const i = this.inflight;
        if (!i || i.settled) return;
        i.settled = true;
        clearTimeout(i.timer);
        this.inflight = null;
        i.resolve(decision);
    }

    private failInflight(err: Error): void {
        const i = this.inflight;
        if (!i || i.settled) return;
        i.settled = true;
        clearTimeout(i.timer);
        this.inflight = null;
        i.reject(err);
    }
}
