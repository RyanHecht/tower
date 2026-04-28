import type { Tool } from "@github/copilot-sdk";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { launchDisplay, getDisplay, destroyDisplay } from "./displayManager.js";
import { setDisplayUrl } from "./sessionAttachments.js";
import { config } from "./config.js";
import type { StateStore } from "./state.js";
import * as messages from "./messageStore.js";
import * as vault from "./vaultStore.js";
import { headlessSend } from "./headlessSend.js";
import type { KeepAliveManager } from "./keepAlive.js";
import { getCopilotClient } from "./copilot.js";
import { attachedSessions } from "./attached.js";

/**
 * Custom tools registered on every Tower session.
 *
 * These run inside the gateway process (not the daemon) and can access
 * gateway-managed resources like the display manager.
 */

/**
 * Chromium auth-related files/dirs to sync between the shared pool and
 * per-session profile. These carry logins, cookies, and site storage —
 * everything else (caches, crash reports, GPU state) stays per-session.
 */
const SYNC_ITEMS = [
    "Default/Cookies",
    "Default/Cookies-journal",
    "Default/Login Data",
    "Default/Login Data-journal",
    "Default/Web Data",
    "Default/Web Data-journal",
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
    "Default/Preferences",
];

/** Copy auth-relevant files from src → dst, creating dirs as needed. */
async function syncAuthFiles(src: string, dst: string): Promise<number> {
    let count = 0;
    for (const item of SYNC_ITEMS) {
        const srcPath = join(src, item);
        const dstPath = join(dst, item);
        if (!existsSync(srcPath)) continue;
        try {
            const dstDir = join(dstPath, "..");
            await mkdir(dstDir, { recursive: true });
            await cp(srcPath, dstPath, { recursive: true, force: true });
            count++;
        } catch {
            // Best-effort — files may be locked if browser is still running.
        }
    }
    return count;
}

/** Get or create the per-session Chromium profile directory, seeded from
 *  the shared auth pool so new sessions inherit accumulated logins. */
async function ensureProfileDir(sessionId: string): Promise<string> {
    const profileDir = join(config.paths.chromiumProfiles, sessionId);
    await mkdir(join(profileDir, "Default"), { recursive: true });

    // Seed from shared pool on every launch — picks up logins from other
    // sessions. Only copies auth files, not caches or session-specific state.
    const shared = config.paths.chromiumShared;
    if (existsSync(shared)) {
        const n = await syncAuthFiles(shared, profileDir);
        if (n > 0) console.log(`[display] synced ${n} auth files from shared pool → ${sessionId}`);
    }
    return profileDir;
}

/** Push this session's auth state back to the shared pool so future
 *  sessions inherit any new logins. */
export async function flushToShared(sessionId: string): Promise<void> {
    const profileDir = join(config.paths.chromiumProfiles, sessionId);
    if (!existsSync(profileDir)) return;
    const shared = config.paths.chromiumShared;
    await mkdir(join(shared, "Default"), { recursive: true });
    const n = await syncAuthFiles(profileDir, shared);
    if (n > 0) console.log(`[display] synced ${n} auth files from ${sessionId} → shared pool`);
}

export function buildSessionTools(store: StateStore, keepAlive: KeepAliveManager): Tool[] {
    return [
        // ── Display tools ──────────────────────────────────────────────
        {
            name: "launch_display",
            description:
                "Launch a virtual desktop (Xvfb + window manager + VNC) for this session. " +
                "This MUST be called before using any Playwright browser tools. " +
                "Returns the display identifier and a noVNC URL the user can open " +
                "to watch the desktop. The Playwright MCP server will be available " +
                "on the next turn after this tool returns. Idempotent — safe to call " +
                "if a display is already running.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                const { sessionId } = invocation;
                try {
                    const info = await launchDisplay(sessionId);
                    const profileDir = await ensureProfileDir(sessionId);
                    setDisplayUrl(sessionId, info.noVncUrl);
                    store.setDisplay(sessionId, true);
                    return {
                        status: "ok",
                        display: info.display,
                        noVncUrl: info.noVncUrl,
                        chromiumProfileDir: profileDir,
                        message:
                            `Virtual display ${info.display} is running. ` +
                            `The user can view it at: http://localhost:8787${info.noVncUrl}\n\n` +
                            `Next: launch Chromium on this display using bash:\n` +
                            `  DISPLAY=${info.display} nohup chromium --no-sandbox ` +
                            `--disable-dev-shm-usage --disable-gpu ` +
                            `--remote-debugging-port=9222 ` +
                            `--user-data-dir=${profileDir} ` +
                            `"https://example.com" ` +
                            `> /tmp/chromium.log 2>&1 & disown $!\n\n` +
                            `The --user-data-dir flag uses a per-session profile directory. ` +
                            `Logins and cookies are synced from a shared pool on launch, ` +
                            `and flushed back when the display is destroyed — so sign-ins ` +
                            `accumulate across sessions automatically.\n\n` +
                            `Take screenshots with: DISPLAY=${info.display} scrot /tmp/screenshot.png`,
                    };
                } catch (err) {
                    return {
                        status: "error",
                        message: `Failed to launch display: ${(err as Error).message}`,
                    };
                }
            },
        },
        {
            name: "get_display",
            description:
                "Check whether this session has a virtual desktop running. " +
                "Returns display info and noVNC URL if active, or a message " +
                "indicating no display is running.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                const info = getDisplay(invocation.sessionId);
                if (!info) {
                    return {
                        status: "no_display",
                        message:
                            "No virtual display is running for this session. " +
                            "Call launch_display first if you need browser tools.",
                    };
                }
                return {
                    status: "ok",
                    display: info.display,
                    noVncUrl: info.noVncUrl,
                };
            },
        },
        {
            name: "destroy_display",
            description:
                "Shut down this session's virtual desktop. Kills the Xvfb, " +
                "window manager, VNC server, and any browser instances running " +
                "on it. Playwright browser tools will no longer work after this.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                // Flush auth state back to the shared pool before tearing
                // down, so future sessions inherit any new logins.
                await flushToShared(invocation.sessionId);
                await destroyDisplay(invocation.sessionId);
                setDisplayUrl(invocation.sessionId, undefined);
                store.setDisplay(invocation.sessionId, false);
                return {
                    status: "ok",
                    message: "Virtual display destroyed. Browser logins synced to shared pool.",
                };
            },
        },

        // ── Messaging tools ────────────────────────────────────────────

        {
            name: "tower_send",
            description:
                "Send a message to one or more sessions, or to a channel (prefix with #). " +
                "Messages are stored as markdown files in data/messages/ and are readable " +
                "by any session. Priority controls delivery: 'urgent' messages are also " +
                "injected as an immediate prompt to online recipients. 'normal' messages " +
                "wait in the inbox. 'low' messages are FYI — excluded from unread counts.",
            parameters: {
                type: "object",
                properties: {
                    to: {
                        description: "Session ID(s) or channel name(s) prefixed with #. Can be a single string or an array.",
                        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                    },
                    message: { type: "string", description: "The message body (markdown supported)." },
                    priority: {
                        type: "string",
                        enum: ["urgent", "normal", "low"],
                        description: "Delivery priority. Default: normal.",
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tags for filtering (e.g., 'research', 'bug').",
                    },
                },
                required: ["to", "message"],
            },
            handler: async (args: unknown, invocation) => {
                const a = args as { to: string | string[]; message: string; priority?: string; tags?: string[] };
                try {
                    const msg = await messages.send({
                        from: invocation.sessionId,
                        to: a.to,
                        body: a.message,
                        priority: (a.priority as messages.Priority) ?? "normal",
                        tags: a.tags,
                    });

                    // Urgent: inject as immediate prompt to recipients.
                    // Always attempt delivery — headlessSend handles both
                    // attached and unattached sessions.
                    if (msg.priority === "urgent") {
                        for (const recipientId of msg.to) {
                            const injected =
                                `[TOWER MESSAGE — id: ${msg.id}, from: ${msg.from}, priority: ${msg.priority}]\n\n` +
                                `${msg.body}\n\n` +
                                `---\n` +
                                `You MUST respond to this message using tower_reply(messageId: "${msg.id}", message: "your response"). ` +
                                `Do NOT just respond in your conversation — the sender is a different session and can only see your reply through the messaging system.`;
                            headlessSend(recipientId, injected, keepAlive)
                                .catch((err) => console.error(`[messages] urgent inject failed for ${recipientId}:`, (err as Error).message));
                        }
                    }

                    return {
                        status: "ok",
                        messageId: msg.id,
                        deliveredTo: msg.to,
                        priority: msg.priority,
                    };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_inbox",
            description:
                "Check this session's message inbox. Returns a list of messages addressed " +
                "to this session, newest first. By default shows unread normal+urgent messages. " +
                "Pass unreadOnly=false to see all, includeLow=true to include FYI messages.",
            parameters: {
                type: "object",
                properties: {
                    unreadOnly: { type: "boolean", description: "Only unread messages (default: true)." },
                    includeLow: { type: "boolean", description: "Include low-priority FYI messages (default: false)." },
                    tag: { type: "string", description: "Filter by tag." },
                    limit: { type: "number", description: "Max results (default: 50)." },
                },
            },
            handler: async (args: unknown, invocation) => {
                const a = (args ?? {}) as { unreadOnly?: boolean; includeLow?: boolean; tag?: string; limit?: number };
                const results = await messages.inbox({
                    sessionId: invocation.sessionId,
                    unreadOnly: a.unreadOnly ?? true,
                    includeLow: a.includeLow ?? false,
                    tag: a.tag,
                    limit: a.limit,
                });
                return { count: results.length, messages: results };
            },
        },
        {
            name: "tower_read",
            description:
                "Read the full content of a message by ID. Also marks it as read for this session.",
            parameters: {
                type: "object",
                properties: {
                    messageId: { type: "string", description: "The message ID (e.g., msg_abc123def456)." },
                },
                required: ["messageId"],
            },
            handler: async (args: unknown, invocation) => {
                const a = args as { messageId: string };
                const msg = await messages.read(a.messageId, invocation.sessionId);
                if (!msg) return { status: "error", message: `Message not found: ${a.messageId}` };
                return { status: "ok", message: msg };
            },
        },
        {
            name: "tower_reply",
            description:
                "Reply to a message. The reply is addressed to the original sender and " +
                "all recipients of the original message (group reply). Creates a threaded " +
                "conversation.",
            parameters: {
                type: "object",
                properties: {
                    messageId: { type: "string", description: "ID of the message to reply to." },
                    message: { type: "string", description: "Reply body (markdown supported)." },
                    priority: {
                        type: "string",
                        enum: ["urgent", "normal", "low"],
                        description: "Override priority (default: inherit from original).",
                    },
                },
                required: ["messageId", "message"],
            },
            handler: async (args: unknown, invocation) => {
                const a = args as { messageId: string; message: string; priority?: string };
                const msg = await messages.reply({
                    messageId: a.messageId,
                    from: invocation.sessionId,
                    body: a.message,
                    priority: a.priority as messages.Priority | undefined,
                });
                if (!msg) return { status: "error", message: `Original message not found: ${a.messageId}` };

                // Urgent replies also get injected.
                if (msg.priority === "urgent") {
                    for (const recipientId of msg.to) {
                        const injected =
                            `[TOWER REPLY — id: ${msg.id}, from: ${msg.from}, in reply to: ${a.messageId}]\n\n` +
                            `${msg.body}\n\n` +
                            `---\n` +
                            `This is a reply via the Tower messaging system. Use tower_read("${msg.id}") to see the full message, ` +
                            `or tower_reply("${msg.id}", "...") to continue the thread.`;
                        headlessSend(recipientId, injected, keepAlive)
                            .catch((err) => console.error(`[messages] urgent inject failed for ${recipientId}:`, (err as Error).message));
                    }
                }

                return { status: "ok", messageId: msg.id, deliveredTo: msg.to };
            },
        },
        {
            name: "tower_sessions",
            description:
                "List all sessions on this Tower instance with their status. " +
                "Use this to discover session IDs for messaging.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                try {
                    const client = await getCopilotClient();
                    const list = await client.listSessions();
                    return {
                        sessions: list.map((s) => ({
                            sessionId: s.sessionId,
                            summary: s.summary,
                            workspace: s.context?.cwd,
                            isActive: attachedSessions.has(s.sessionId),
                            lastActivity: s.modifiedTime?.toISOString?.() ?? undefined,
                        })),
                    };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },

        // ── Memory tools ───────────────────────────────────────────────

        {
            name: "tower_remember",
            description:
                "Store a fact in Tower's persistent knowledge vault. The fact is " +
                "appended to a topic file in _memory/. Provide a topic to organize " +
                "facts (e.g., 'people/bob', 'topics/rust', 'topics/tower'). " +
                "Facts persist across sessions and container restarts.",
            parameters: {
                type: "object",
                properties: {
                    fact: { type: "string", description: "The fact to remember (concise, one statement)." },
                    topic: { type: "string", description: "Topic path (e.g., 'people/bob', 'topics/rust'). Determines which file the fact is stored in." },
                },
                required: ["fact"],
            },
            handler: async (args: unknown) => {
                const a = args as { fact: string; topic?: string };
                const topic = a.topic ?? "topics/general";
                try {
                    await vault.appendToMemory(topic, `- ${a.fact}`, `memory: ${a.fact.slice(0, 60)}`);
                    return { status: "ok", topic, fact: a.fact };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_recall",
            description:
                "Search Tower's knowledge vault for information. Uses grep to find " +
                "matching facts across all memory files, core memory, and session " +
                "summaries. Returns matching lines with file paths.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query (keywords or phrases)." },
                    vault_name: { type: "string", description: "Optional: search a specific user vault instead of the main vault." },
                },
                required: ["query"],
            },
            handler: async (args: unknown) => {
                const a = args as { query: string; vault_name?: string };
                try {
                    const results = await vault.vaultSearch(a.query, a.vault_name);
                    if (results.length === 0) return { status: "ok", count: 0, message: "No matches found." };
                    return { status: "ok", count: results.length, results };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_core_read",
            description:
                "Read the core memory — the persistent facts that are injected into " +
                "every session's system prompt. Sections: 'user' (who the user is), " +
                "'preferences' (how they like things done), 'context' (current goals). " +
                "Omit section to read all.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        enum: ["user", "preferences", "context"],
                        description: "Which core memory section to read. Omit to read all.",
                    },
                },
            },
            handler: async (args: unknown) => {
                const a = (args ?? {}) as { section?: string };
                try {
                    if (a.section) {
                        const content = await vault.readCoreSection(a.section);
                        return { status: "ok", section: a.section, content };
                    }
                    const content = await vault.readCoreMemory();
                    return { status: "ok", content };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_core_update",
            description:
                "Update a section of core memory. Core memory is always injected into " +
                "the system prompt of every session, so keep it concise and current. " +
                "You should REWRITE the entire section content (not append) — replace " +
                "stale facts with current ones. Sections: 'user', 'preferences', 'context'.",
            parameters: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        enum: ["user", "preferences", "context"],
                        description: "Which core memory section to update.",
                    },
                    content: { type: "string", description: "The new content for this section (markdown). Replaces the entire section." },
                },
                required: ["section", "content"],
            },
            handler: async (args: unknown) => {
                const a = args as { section: string; content: string };
                try {
                    await vault.updateCoreSection(a.section, a.content);
                    return { status: "ok", section: a.section, message: "Core memory updated." };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_vault_read",
            description: "Read a file from the knowledge vault (or a named user vault).",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path relative to vault root (e.g., '_memory/people/bob.md')." },
                    vault: { type: "string", description: "Optional: name of a user vault." },
                },
                required: ["path"],
            },
            handler: async (args: unknown) => {
                const a = args as { path: string; vault?: string };
                const content = await vault.vaultRead(a.path, a.vault);
                if (content === null) return { status: "error", message: `File not found: ${a.path}` };
                return { status: "ok", path: a.path, content };
            },
        },
        {
            name: "tower_vault_write",
            description: "Write a file to the knowledge vault. Auto-commits to git.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path relative to vault root." },
                    content: { type: "string", description: "File content (markdown)." },
                    vault: { type: "string", description: "Optional: name of a user vault." },
                },
                required: ["path", "content"],
            },
            handler: async (args: unknown) => {
                const a = args as { path: string; content: string; vault?: string };
                try {
                    await vault.vaultWrite(a.path, a.content, a.vault);
                    return { status: "ok", path: a.path };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: "tower_vault_list",
            description: "List markdown files in the knowledge vault.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory path relative to vault root. Omit to list all." },
                    vault: { type: "string", description: "Optional: name of a user vault." },
                },
            },
            handler: async (args: unknown) => {
                const a = (args ?? {}) as { path?: string; vault?: string };
                try {
                    const files = await vault.vaultList(a.path, a.vault);
                    return { status: "ok", count: files.length, files };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
    ];
}
