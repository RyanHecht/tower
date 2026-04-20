import type { MCPServerConfig, CustomAgentConfig } from "@github/copilot-sdk";
import { getDisplay } from "./displayManager.js";

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

// ---------------------------------------------------------------------------
// Built-in MCP servers
// ---------------------------------------------------------------------------

/** MCP servers that Tower provides out of the box. */
function builtinMcpServers(sessionId: string): Record<string, MCPServerConfig> {
    const servers: Record<string, MCPServerConfig> = {};

    // Playwright browser automation — only added when the session has a
    // virtual display, so the headed browser has somewhere to render.
    const display = getDisplay(sessionId);
    if (display) {
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
}

/**
 * Build the merged session configuration for a given session.
 *
 * Call this right before `client.createSession()` / `client.resumeSession()`
 * and spread the result into the SDK config.
 */
export function buildSessionConfig(sessionId: string): SessionConfigBundle {
    const mcpServers: Record<string, MCPServerConfig> = {
        ...builtinMcpServers(sessionId),
        ...userConfig.mcpServers,
    };

    const skillDirectories: string[] = [
        ...(userConfig.skillDirectories ?? []),
    ];

    const disabledSkills: string[] = [
        ...(userConfig.disabledSkills ?? []),
    ];

    const customAgents: CustomAgentConfig[] = [
        ...(userConfig.customAgents ?? []),
    ];

    return { mcpServers, skillDirectories, disabledSkills, customAgents };
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
