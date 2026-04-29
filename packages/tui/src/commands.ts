/**
 * TUI slash-command system.
 *
 * Intercepts input that starts with `/` followed by a known command name and
 * dispatches it to the gateway protocol instead of `session.send`. Unknown
 * `/foo` is passed through as a regular prompt — so `/home/ryan/file.ts`
 * reaches the agent normally.
 */

import type { TowerClient } from "./client.js";
import type { TimelineApi } from "./views/timeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
    client: TowerClient;
    sessionId: string;
    api: TimelineApi;
}

type CommandFn = (args: string, ctx: CommandContext) => Promise<void>;

interface Command {
    name: string;
    description: string;
    execute: CommandFn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const info = (ctx: CommandContext, text: string) => ctx.api.push({ kind: "info", text });
const warn = (ctx: CommandContext, text: string) => ctx.api.push({ kind: "warning", text });

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

const modelCmd: Command = {
    name: "model",
    description: "List available models or switch: /model [<id>]",
    async execute(args, ctx) {
        if (args) {
            // Switch model
            const id = info(ctx, `switching model to ${args}…`);
            try {
                const result = await ctx.client.request<{ modelId?: string }>(
                    "session.model.set",
                    { sessionId: ctx.sessionId, model: args },
                );
                ctx.api.update(id, { text: `model → ${result.modelId ?? args}` });
            } catch (err) {
                ctx.api.update(id, { kind: "warning", text: `/model: ${(err as Error).message}` });
            }
            return;
        }
        // List models + show current
        const id = info(ctx, "fetching models…");
        try {
            const [list, current] = await Promise.all([
                ctx.client.request<{ models: Array<{ id: string; name: string }> }>("models.list"),
                ctx.client.request<{ modelId?: string }>("session.model.get", { sessionId: ctx.sessionId }),
            ]);
            const lines = list.models.map((m) => {
                const marker = m.id === current.modelId ? " ●" : "";
                return `  ${m.id} (${m.name})${marker}`;
            });
            ctx.api.update(id, {
                text: `models (current: ${current.modelId ?? "unknown"}):\n${lines.join("\n")}`,
            });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/model: ${(err as Error).message}` });
        }
    },
};

const modeCmd: Command = {
    name: "mode",
    description: "Get or set agent mode: /mode [interactive|plan|autopilot]",
    async execute(args, ctx) {
        if (args) {
            const mode = args.toLowerCase();
            if (!["interactive", "plan", "autopilot"].includes(mode)) {
                warn(ctx, `/mode: invalid mode "${args}" — use interactive, plan, or autopilot`);
                return;
            }
            const id = info(ctx, `switching to ${mode} mode…`);
            try {
                const result = await ctx.client.request<{ mode: string }>(
                    "session.mode.set",
                    { sessionId: ctx.sessionId, mode },
                );
                ctx.api.update(id, { text: `mode → ${result.mode}` });
            } catch (err) {
                ctx.api.update(id, { kind: "warning", text: `/mode: ${(err as Error).message}` });
            }
            return;
        }
        // Show current mode
        const id = info(ctx, "fetching mode…");
        try {
            const result = await ctx.client.request<{ mode: string }>(
                "session.mode.get",
                { sessionId: ctx.sessionId },
            );
            ctx.api.update(id, { text: `mode: ${result.mode}` });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/mode: ${(err as Error).message}` });
        }
    },
};

const planCmd: Command = {
    name: "plan",
    description: "Switch to plan mode (shortcut for /mode plan)",
    async execute(_args, ctx) {
        const id = info(ctx, "switching to plan mode…");
        try {
            const result = await ctx.client.request<{ mode: string }>(
                "session.mode.set",
                { sessionId: ctx.sessionId, mode: "plan" },
            );
            ctx.api.update(id, { text: `mode → ${result.mode}` });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/plan: ${(err as Error).message}` });
        }
    },
};

const compactCmd: Command = {
    name: "compact",
    description: "Compact context window to free tokens",
    async execute(_args, ctx) {
        const id = info(ctx, "compacting context…");
        try {
            const result = await ctx.client.request<{
                success: boolean;
                tokensRemoved: number;
                messagesRemoved: number;
            }>("session.compact", { sessionId: ctx.sessionId });
            ctx.api.update(id, {
                text: `compacted: ${result.tokensRemoved.toLocaleString()} tokens freed, ${result.messagesRemoved} messages removed`,
            });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/compact: ${(err as Error).message}` });
        }
    },
};

const usageCmd: Command = {
    name: "usage",
    description: "Display quota and usage statistics",
    async execute(_args, ctx) {
        const id = info(ctx, "fetching quota…");
        try {
            const result = await ctx.client.request<{
                quotaSnapshots: Record<
                    string,
                    {
                        entitlementRequests: number;
                        usedRequests: number;
                        remainingPercentage: number;
                        overage: number;
                        resetDate?: string;
                    }
                >;
            }>("account.quota");
            const lines: string[] = [];
            for (const [type, snap] of Object.entries(result.quotaSnapshots)) {
                const reset = snap.resetDate ? ` (resets ${snap.resetDate})` : "";
                lines.push(
                    `  ${type}: ${snap.usedRequests}/${snap.entitlementRequests} used, ` +
                    `${snap.remainingPercentage.toFixed(0)}% remaining` +
                    (snap.overage > 0 ? `, ${snap.overage} overage` : "") +
                    reset,
                );
            }
            ctx.api.update(id, { text: `quota:\n${lines.join("\n")}` });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/usage: ${(err as Error).message}` });
        }
    },
};

const fleetCmd: Command = {
    name: "fleet",
    description: "Start fleet mode for parallel sub-agents: /fleet [<prompt>]",
    async execute(args, ctx) {
        const id = info(ctx, "starting fleet mode…");
        try {
            const payload: Record<string, unknown> = { sessionId: ctx.sessionId };
            if (args) payload.prompt = args;
            const result = await ctx.client.request<{ started: boolean }>(
                "session.fleet.start",
                payload,
            );
            ctx.api.update(id, {
                text: result.started ? "fleet mode activated" : "fleet mode could not be started",
            });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/fleet: ${(err as Error).message}` });
        }
    },
};

const agentCmd: Command = {
    name: "agent",
    description: "List or switch agents: /agent [<name>|none]",
    async execute(args, ctx) {
        if (args) {
            if (args.toLowerCase() === "none") {
                const id = info(ctx, "deselecting agent…");
                try {
                    await ctx.client.request("session.agent.deselect", { sessionId: ctx.sessionId });
                    ctx.api.update(id, { text: "agent deselected (using default)" });
                } catch (err) {
                    ctx.api.update(id, { kind: "warning", text: `/agent: ${(err as Error).message}` });
                }
                return;
            }
            const id = info(ctx, `selecting agent ${args}…`);
            try {
                const result = await ctx.client.request<{
                    agent: { name: string; displayName: string };
                }>("session.agent.select", { sessionId: ctx.sessionId, name: args });
                ctx.api.update(id, { text: `agent → ${result.agent.displayName} (${result.agent.name})` });
            } catch (err) {
                ctx.api.update(id, { kind: "warning", text: `/agent: ${(err as Error).message}` });
            }
            return;
        }
        // List agents + show current
        const id = info(ctx, "fetching agents…");
        try {
            const [list, current] = await Promise.all([
                ctx.client.request<{
                    agents: Array<{ name: string; displayName: string; description: string }>;
                }>("session.agent.list", { sessionId: ctx.sessionId }),
                ctx.client.request<{
                    agent: { name: string; displayName: string } | null;
                }>("session.agent.get", { sessionId: ctx.sessionId }),
            ]);
            if (list.agents.length === 0) {
                ctx.api.update(id, { text: "no custom agents available" });
                return;
            }
            const lines = list.agents.map((a) => {
                const marker = a.name === current.agent?.name ? " ●" : "";
                return `  ${a.name} — ${a.description}${marker}`;
            });
            const cur = current.agent ? current.agent.displayName : "default";
            ctx.api.update(id, {
                text: `agents (current: ${cur}):\n${lines.join("\n")}`,
            });
        } catch (err) {
            ctx.api.update(id, { kind: "warning", text: `/agent: ${(err as Error).message}` });
        }
    },
};

const helpCmd: Command = {
    name: "help",
    description: "List available slash commands",
    async execute(_args, ctx) {
        const lines = COMMANDS.map((c) => `  /${c.name} — ${c.description}`);
        info(ctx, `commands:\n${lines.join("\n")}`);
    },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const COMMANDS: Command[] = [
    modelCmd,
    modeCmd,
    planCmd,
    compactCmd,
    usageCmd,
    fleetCmd,
    agentCmd,
    helpCmd,
];

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Command metadata exposed for autocomplete UIs. */
export interface CommandInfo {
    name: string;
    description: string;
}

export const COMMAND_LIST: readonly CommandInfo[] = COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
}));

/** Match `/commandname args...` — only word characters in the command name. */
const SLASH_RE = /^\/([a-z]+)(?:\s+(.*))?$/i;

/**
 * If `input` is a known slash command, execute it and return `true`.
 * Unknown `/foo` returns `false` so the caller can send it as a regular
 * prompt — this avoids breaking inputs like `/home/ryan/file.ts`.
 */
export function trySlashCommand(input: string, ctx: CommandContext): boolean {
    const m = SLASH_RE.exec(input);
    if (!m) return false;
    const name = m[1]!.toLowerCase();
    const args = (m[2] ?? "").trim();
    const cmd = COMMAND_MAP.get(name);
    if (!cmd) return false;
    cmd.execute(args, ctx).catch((err) => {
        warn(ctx, `/${name}: ${(err as Error).message}`);
    });
    return true;
}
