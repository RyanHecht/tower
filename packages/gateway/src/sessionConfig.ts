import type { MCPServerConfig, CustomAgentConfig, Tool } from "@github/copilot-sdk";
import { getDisplay, launchDisplay } from "./displayManager.js";
import { setDisplayUrl } from "./sessionAttachments.js";
import { buildSessionTools } from "./sessionTools.js";
import { readCoreMemory, readSchema } from "./vaultStore.js";
import type { StateStore } from "./state.js";
import type { KeepAliveManager } from "./keepAlive.js";

/**
 * Session configuration layer.
 *
 * Builds the `mcpServers`, `skillDirectories`, and `customAgents` that every
 * Tower session should receive. Composed from three sources (in merge order):
 *
 *   1. **Built-in**  — hard-coded defaults that ship with Tower (e.g., the
 *      Playwright MCP server when a display is active).
 *   2. **User**      — loaded from `data/session-config.json` so the operator
 *      can add their own MCP servers / skills / agents without editing code.
 *   3. **Per-session** — dynamic additions from the gateway at runtime
 *      (e.g., display-specific env vars injected into Playwright).
 *
 * Later sources override earlier ones by key (mcpServers) or append (arrays).
 */

// ---------------------------------------------------------------------------
// User config file (data/session-config.json)
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface UserSessionConfig {
    /** MCP servers to include in every session. */
    mcpServers?: Record<string, MCPServerConfig>;
    /** Directories to load skills from. */
    skillDirectories?: string[];
    /** Skills to disable. */
    disabledSkills?: string[];
    /** Custom agents available in every session. */
    customAgents?: CustomAgentConfig[];
    /** Workspace name for the triage session. When set, inbox items trigger
     *  a headlessSend to the active session in this workspace. */
    triageWorkspace?: string;
}

const USER_CONFIG_PATH = join(config.paths.data, "session-config.json");

let userConfig: UserSessionConfig = {};

/** Load user config from disk. Called once at startup. */
export async function loadUserSessionConfig(): Promise<void> {
    try {
        const raw = await fs.readFile(USER_CONFIG_PATH, "utf8");
        userConfig = JSON.parse(raw) as UserSessionConfig;
        const mcpCount = Object.keys(userConfig.mcpServers ?? {}).length;
        const skillCount = (userConfig.skillDirectories ?? []).length;
        const agentCount = (userConfig.customAgents ?? []).length;
        if (mcpCount + skillCount + agentCount > 0) {
            console.log(
                `[sessionConfig] loaded user config: ${mcpCount} MCP server(s), ` +
                `${skillCount} skill dir(s), ${agentCount} custom agent(s)`,
            );
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[sessionConfig] failed to load ${USER_CONFIG_PATH}:`, (err as Error).message);
        }
    }
}

/** Get the configured triage workspace name (if any). */
export function getTriageWorkspace(): string | undefined {
    return userConfig.triageWorkspace;
}

// ---------------------------------------------------------------------------
// Built-in MCP servers
// ---------------------------------------------------------------------------

/** MCP servers that Tower provides out of the box. */
function builtinMcpServers(sessionId: string): Record<string, MCPServerConfig> {
    const servers: Record<string, MCPServerConfig> = {};

    // Only added when the session has a virtual display.
    const display = getDisplay(sessionId);
    if (display) {
        // Playwright browser automation — structured browser control via
        // accessibility tree and CDP. Manages its own browser instance.
        servers["playwright"] = {
            command: "playwright-mcp",
            args: [
                "--browser", "chromium",
                "--executable-path", "/usr/bin/chromium",
                "--caps", "vision",
            ],
            env: {
                DISPLAY: display.display,
                // Chromium flags for the container environment.
                CHROMIUM_FLAGS: "--no-sandbox --disable-dev-shm-usage",
            },
            tools: ["*"],
        };

        // Computer-use desktop control — generic mouse/keyboard/screenshot
        // tools for interacting with any application on the display.
        servers["computer-use"] = {
            command: "node",
            args: [join(config.root, "packages/computer-use-mcp/dist/index.js")],
            env: {
                DISPLAY: display.display,
            },
            tools: ["*"],
        };
    }

    return servers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SessionConfigBundle {
    mcpServers: Record<string, MCPServerConfig>;
    skillDirectories: string[];
    disabledSkills: string[];
    customAgents: CustomAgentConfig[];
    /** Custom tools that run inside the gateway process. */
    tools: Tool[];
    /** Structured system prompt content to append. */
    systemPromptContent: string;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

const TOWER_CONTEXT = `You are an agent running inside Tower, a long-lived daemon. Your session \
persists even when the user disconnects — you keep working. You have access to:

- **Vault** (tower_vault_*) — persistent knowledge base. Read, write, append, list, and search files.
- **Vault inbox** (tower_vault_inbox_*) — external data awaiting triage/processing.
- **Messaging** (tower_msg_*) — send/receive messages between sessions on this host.
- **Display** (tower_display_*) — virtual desktop with headed browser and terminal.
- **Sessions** (tower_session_list) — discover other sessions on this host.

Proactive behavior:
- When you learn important facts during conversation, store them in the vault \
using tower_vault_remember (quick facts) or tower_vault_append/tower_vault_write \
(structured updates). Follow the vault schema below for where things go.
- Core memory (_core/) is injected into every session's system prompt. Keep it \
concise and current — rewrite sections rather than appending.`;

const SCHEMA_TOKEN_BUDGET = 2000;

async function buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    // 1. Tower context (static).
    parts.push(`<tower-context>\n${TOWER_CONTEXT}\n</tower-context>`);

    // 2. Vault schema (user-defined).
    let schema = await readSchema();
    if (schema.trim()) {
        // Rough token estimate: ~4 chars per token.
        if (schema.length > SCHEMA_TOKEN_BUDGET * 4) {
            schema = schema.slice(0, SCHEMA_TOKEN_BUDGET * 4) +
                "\n\n[Schema truncated — keep _schema.md under ~2000 tokens]";
            console.warn("[sessionConfig] _schema.md exceeds token budget, truncated");
        }
        parts.push(`<tower-vault-schema>\n${schema.trim()}\n</tower-vault-schema>`);
    }

    // 3. Core memory (user/agent-maintained).
    const coreMemory = await readCoreMemory();
    if (coreMemory.trim()) {
        parts.push(`<tower-core-memory>\n${coreMemory.trim()}\n</tower-core-memory>`);
    }

    return parts.join("\n\n");
}

/**
 * Build the merged session configuration for a given session.
 *
 * Call this right before `client.createSession()` / `client.resumeSession()`
 * and spread the result into the SDK config.
 */
export async function buildSessionConfig(sessionId: string, store: StateStore, keepAlive: KeepAliveManager): Promise<SessionConfigBundle> {
    const mcpServers: Record<string, MCPServerConfig> = {
        ...builtinMcpServers(sessionId),
        ...userConfig.mcpServers,
    };

    const skillDirectories: string[] = [
        // Built-in Tower skills (browser, etc.)
        `${config.root}/skills`,
        ...(userConfig.skillDirectories ?? []),
    ];

    const disabledSkills: string[] = [
        ...(userConfig.disabledSkills ?? []),
    ];

    const customAgents: CustomAgentConfig[] = [
        ...(userConfig.customAgents ?? []),
    ];

    const tools: Tool[] = buildSessionTools(store, keepAlive);
    const systemPromptContent = await buildSystemPrompt();

    return { mcpServers, skillDirectories, disabledSkills, customAgents, tools, systemPromptContent };
}

/**
 * If a session previously had a display, re-launch it. Called during
 * session.resume so the display is ready before the SDK handle starts.
 */
export async function ensurePersistedDisplay(sessionId: string, store: StateStore): Promise<void> {
    if (!store.hasDisplay(sessionId)) return;
    if (getDisplay(sessionId)) return; // already running
    try {
        const info = await launchDisplay(sessionId);
        setDisplayUrl(sessionId, info.noVncUrl);
        console.log(`[sessionConfig] auto-launched persisted display for ${sessionId}`);
    } catch (err) {
        console.error(`[sessionConfig] failed to auto-launch display for ${sessionId}:`, (err as Error).message);
    }
}

/**
 * Build MCP servers config for a specific session, useful for dynamic
 * additions like display-specific Playwright after display.launch.
 */
export function buildMcpServersForSession(sessionId: string): Record<string, MCPServerConfig> {
    return {
        ...builtinMcpServers(sessionId),
        ...userConfig.mcpServers,
    };
}
