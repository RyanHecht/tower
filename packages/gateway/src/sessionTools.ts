import type { Tool } from "@github/copilot-sdk";
import { createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { launchDisplay, getDisplay, destroyDisplay, registerProcess } from "./displayManager.js";
import { setDisplayUrl } from "./sessionAttachments.js";
import { config } from "./config.js";
import { ensureProfileDir, flushToShared } from "./chromiumProfile.js";
import type { StateStore } from "./state.js";
import * as messages from "./messageStore.js";
import * as vault from "./vaultStore.js";
import { headlessSend } from "./headlessSend.js";
import type { KeepAliveManager } from "./keepAlive.js";
import { getCopilotClient } from "./copilot.js";
import { attachedSessions } from "./attached.js";
import * as T from "./toolNames.js";

// Re-export so existing consumers (connection.ts, index.ts) don't break.
export { flushToShared } from "./chromiumProfile.js";

/**
 * Custom tools registered on every Tower session.
 *
 * These run inside the gateway process (not the daemon) and can access
 * gateway-managed resources like the display manager.
 */

export function buildSessionTools(store: StateStore, keepAlive: KeepAliveManager): Tool[] {
    return [
        // ── Display tools ──────────────────────────────────────────────
        {
            name: T.TOWER_DISPLAY_LAUNCH,
            description:
                "Launch a virtual desktop (Xvfb + window manager + VNC) for this session. " +
                "Returns the display identifier and a noVNC URL the user can open " +
                `to watch the desktop. After launching, use ${T.TOWER_DISPLAY_BROWSER} or ` +
                `${T.TOWER_DISPLAY_TERMINAL} to start applications on it, and computer-use ` +
                "tools (screenshot, mouse_click, type_text, etc.) to interact. " +
                "Idempotent — safe to call if a display is already running.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                const { sessionId } = invocation;
                try {
                    const info = await launchDisplay(sessionId);
                    setDisplayUrl(sessionId, info.noVncUrl);
                    store.setDisplay(sessionId, true);
                    return {
                        status: "ok",
                        display: info.display,
                        displayNum: info.displayNum,
                        noVncUrl: info.noVncUrl,
                        message:
                            `Virtual display ${info.display} is running. ` +
                            `The user can view it at: http://localhost:8787${info.noVncUrl}\n\n` +
                            `Next steps:\n` +
                            `- Call ${T.TOWER_DISPLAY_BROWSER} to open a Chromium browser on the display\n` +
                            `- Call ${T.TOWER_DISPLAY_TERMINAL} to open a terminal emulator on the display\n` +
                            `- Use computer-use tools (screenshot, mouse_click, type_text, press_key) to interact\n\n` +
                            `The Playwright MCP browser tools and computer-use tools will be ` +
                            `available on the next turn after this tool returns.`,
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
            name: T.TOWER_DISPLAY_BROWSER,
            description:
                "Launch a headed Chromium browser on this session's virtual display. " +
                `The display MUST be running first (call ${T.TOWER_DISPLAY_LAUNCH}). ` +
                "Starts Chromium with a per-session profile (logins/cookies persist " +
                "across sessions) and a CDP debugging port for direct control. " +
                "Idempotent — returns existing info if Chromium is already running.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Initial URL to open. Default: about:blank.",
                    },
                },
            },
            handler: async (args: unknown, invocation) => {
                const { sessionId } = invocation;
                const display = getDisplay(sessionId);
                if (!display) {
                    return {
                        status: "error",
                        message: `No virtual display running. Call ${T.TOWER_DISPLAY_LAUNCH} first.`,
                    };
                }
                try {
                    const profileDir = await ensureProfileDir(sessionId);
                    const cdpPort = 9200 + display.displayNum;
                    const url = (args as { url?: string }).url ?? "about:blank";

                    const logPath = join(config.paths.logs, `chromium-${sessionId.slice(0, 8)}.log`);
                    const log = createWriteStream(logPath, { flags: "a" });

                    const proc = spawn("chromium", [
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        `--remote-debugging-port=${cdpPort}`,
                        `--user-data-dir=${profileDir}`,
                        url,
                    ], {
                        stdio: ["ignore", "pipe", "pipe"],
                        env: { ...process.env, DISPLAY: display.display },
                    });
                    proc.stdout?.pipe(log, { end: false });
                    proc.stderr?.pipe(log, { end: false });
                    registerProcess(sessionId, proc);

                    // Brief wait for Chromium to initialize.
                    await new Promise((r) => setTimeout(r, 2000));

                    return {
                        status: "ok",
                        cdpPort,
                        display: display.display,
                        chromiumProfileDir: profileDir,
                        noVncUrl: display.noVncUrl,
                        message:
                            `Chromium launched on ${display.display} with CDP port ${cdpPort}.\n\n` +
                            `CDP API: http://localhost:${cdpPort}/json/list\n` +
                            `Profile: ${profileDir}\n` +
                            `noVNC: http://localhost:8787${display.noVncUrl}\n\n` +
                            `Logins and cookies are synced from a shared pool on launch ` +
                            `and flushed back when the display is destroyed.\n\n` +
                            `Note: Playwright MCP tools (browser_navigate, browser_click, etc.) ` +
                            `manage their own separate browser instance and are also available.`,
                    };
                } catch (err) {
                    return {
                        status: "error",
                        message: `Failed to launch browser: ${(err as Error).message}`,
                    };
                }
            },
        },
        {
            name: T.TOWER_DISPLAY_TERMINAL,
            description:
                "Launch a terminal emulator (xterm) on this session's virtual display. " +
                `The display MUST be running first (call ${T.TOWER_DISPLAY_LAUNCH}). ` +
                "The terminal is visible via noVNC so the user can watch and interact. " +
                "Use computer-use tools (type_text, press_key, screenshot) to drive it.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "Command to run in the terminal. Default: interactive shell.",
                    },
                },
            },
            handler: async (args: unknown, invocation) => {
                const { sessionId } = invocation;
                const display = getDisplay(sessionId);
                if (!display) {
                    return {
                        status: "error",
                        message: `No virtual display running. Call ${T.TOWER_DISPLAY_LAUNCH} first.`,
                    };
                }
                try {
                    const a = (args ?? {}) as { command?: string };
                    const xtermArgs = ["-fa", "Monospace", "-fs", "12"];
                    if (a.command) {
                        xtermArgs.push("-e", a.command);
                    }

                    const proc = spawn("xterm", xtermArgs, {
                        stdio: ["ignore", "pipe", "pipe"],
                        env: { ...process.env, DISPLAY: display.display },
                    });
                    registerProcess(sessionId, proc);

                    // Brief wait for xterm to appear.
                    await new Promise((r) => setTimeout(r, 1000));

                    return {
                        status: "ok",
                        display: display.display,
                        noVncUrl: display.noVncUrl,
                        message:
                            `Terminal launched on ${display.display}.\n` +
                            `Visible at: http://localhost:8787${display.noVncUrl}\n\n` +
                            `Use computer-use tools to interact:\n` +
                            `- type_text to type commands\n` +
                            `- press_key for special keys (Return, ctrl+c, Tab, etc.)\n` +
                            `- screenshot to see the terminal output`,
                    };
                } catch (err) {
                    return {
                        status: "error",
                        message: `Failed to launch terminal: ${(err as Error).message}`,
                    };
                }
            },
        },
        {
            name: T.TOWER_DISPLAY_STATUS,
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
                            `Call ${T.TOWER_DISPLAY_LAUNCH} first if you need browser tools.`,
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
            name: T.TOWER_DISPLAY_DESTROY,
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
            name: T.TOWER_MSG_SEND,
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
                                `You MUST respond to this message using ${T.TOWER_MSG_REPLY}(messageId: "${msg.id}", message: "your response"). ` +
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
            name: T.TOWER_MSG_INBOX,
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
            name: T.TOWER_MSG_READ,
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
            name: T.TOWER_MSG_REPLY,
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
                            `This is a reply via the Tower messaging system. Use ${T.TOWER_MSG_READ}("${msg.id}") to see the full message, ` +
                            `or ${T.TOWER_MSG_REPLY}("${msg.id}", "...") to continue the thread.`;
                        headlessSend(recipientId, injected, keepAlive)
                            .catch((err) => console.error(`[messages] urgent inject failed for ${recipientId}:`, (err as Error).message));
                    }
                }

                return { status: "ok", messageId: msg.id, deliveredTo: msg.to };
            },
        },
        {
            name: T.TOWER_SESSION_LIST,
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
            name: T.TOWER_VAULT_REMEMBER,
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
            name: T.TOWER_VAULT_READ,
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
            name: T.TOWER_VAULT_WRITE,
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
            name: T.TOWER_VAULT_LIST,
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

        // ── Vault append ───────────────────────────────────────────────

        {
            name: T.TOWER_VAULT_APPEND,
            description:
                "Append content to a vault file. Creates the file if it doesn't exist. " +
                "Use this for adding entries to task lists, decision logs, or any file " +
                "where you want to add without replacing existing content. The content " +
                "is appended with a newline separator.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path relative to vault root (e.g., 'wiki/tasks.md')." },
                    content: { type: "string", description: "Content to append." },
                    vault: { type: "string", description: "Optional: name of a user vault." },
                },
                required: ["path", "content"],
            },
            handler: async (args: unknown) => {
                const a = args as { path: string; content: string; vault?: string };
                try {
                    await vault.vaultAppend(a.path, a.content, a.vault);
                    return { status: "ok", path: a.path };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },

        // ── Vault search ───────────────────────────────────────────────

        {
            name: T.TOWER_VAULT_SEARCH,
            description:
                "Search the knowledge vault for information. Uses grep to find " +
                "matching lines across vault files. Returns matching lines with " +
                "file paths. Use the scope parameter to focus the search.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query (keywords or phrases)." },
                    scope: {
                        type: "string",
                        enum: ["all", "memory", "inbox"],
                        description:
                            "Search scope. 'all' (default) searches the entire vault. " +
                            "'memory' searches only curated knowledge (_memory/ and _core/). " +
                            "'inbox' searches only unprocessed inbox items.",
                    },
                    vault_name: { type: "string", description: "Optional: search a specific user vault instead of the main vault." },
                },
                required: ["query"],
            },
            handler: async (args: unknown) => {
                const a = args as { query: string; scope?: "all" | "memory" | "inbox"; vault_name?: string };
                try {
                    const results = await vault.vaultSearch(a.query, a.vault_name, a.scope);
                    if (results.length === 0) return { status: "ok", count: 0, message: "No matches found." };
                    return { status: "ok", count: results.length, results };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },

        // ── Vault inbox ────────────────────────────────────────────────

        {
            name: T.TOWER_VAULT_INBOX_ADD,
            description:
                "Add an item to the vault inbox. The inbox is a staging area for " +
                "external data (emails, messages, meeting notes, etc.) that needs " +
                "to be triaged and indexed into the knowledge base. Items are " +
                "immutable once written — the source content is never modified.",
            parameters: {
                type: "object",
                properties: {
                    body: { type: "string", description: "The content of the item." },
                    source: { type: "string", description: "Where this item came from (e.g., 'email', 'slack', 'user-paste')." },
                    category: { type: "string", description: "Category subdirectory (e.g., 'emails', 'meetings', 'messages'). Normalized to lowercase." },
                    title: { type: "string", description: "Optional title for the item. Used in the filename." },
                    externalId: { type: "string", description: "Optional idempotency key. If provided and a matching item exists, returns duplicate instead of creating a new one." },
                },
                required: ["body", "source", "category"],
            },
            handler: async (args: unknown) => {
                const a = args as { body: string; source: string; category: string; title?: string; externalId?: string };
                try {
                    const result = await vault.inboxAdd(a);
                    return {
                        status: "ok",
                        itemId: result.itemId,
                        path: result.path,
                        duplicate: result.duplicate,
                    };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: T.TOWER_VAULT_INBOX_PENDING,
            description:
                "List vault inbox items awaiting processing. Returns items that " +
                "have not yet been triaged, with content previews. Use this to " +
                "see what needs to be processed from the inbox.",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", description: "Filter by category (e.g., 'emails'). Omit to list all." },
                    status: {
                        type: "string",
                        enum: ["new", "processed", "failed"],
                        description: "Filter by status. Default: 'new' (unprocessed items).",
                    },
                    limit: { type: "number", description: "Maximum items to return (default: 50)." },
                },
            },
            handler: async (args: unknown) => {
                const a = (args ?? {}) as { category?: string; status?: "new" | "processed" | "failed"; limit?: number };
                try {
                    const items = await vault.listInboxItems(a);
                    return { status: "ok", count: items.length, items };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
        {
            name: T.TOWER_VAULT_INBOX_DONE,
            description:
                "Mark a vault inbox item as processed or failed. Call this after " +
                "you have extracted and routed information from the item into the " +
                "appropriate vault files.",
            parameters: {
                type: "object",
                properties: {
                    itemId: { type: "string", description: "The item ID (filename without .md extension)." },
                    status: {
                        type: "string",
                        enum: ["processed", "failed"],
                        description: "Whether processing succeeded or failed.",
                    },
                    notes: { type: "string", description: "Optional notes about what was done or why it failed." },
                },
                required: ["itemId", "status"],
            },
            handler: async (args: unknown, invocation) => {
                const a = args as { itemId: string; status: "processed" | "failed"; notes?: string };
                try {
                    await vault.markInboxProcessed(a.itemId, invocation.sessionId, a.status, a.notes);
                    return { status: "ok", itemId: a.itemId, markedAs: a.status };
                } catch (err) {
                    return { status: "error", message: (err as Error).message };
                }
            },
        },
    ];
}
