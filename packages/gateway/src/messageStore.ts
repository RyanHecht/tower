import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * File-based inter-session message board.
 *
 * Every message is a markdown file with YAML frontmatter stored at
 * `data/messages/<messageId>.md`. Agents can read these directly with
 * view/grep, or use the tower_inbox/tower_send tools for convenience.
 *
 * Channels live in `data/messages/channels/<name>.json`.
 */

const MESSAGES_DIR = join(config.paths.data, "messages");
const CHANNELS_DIR = join(MESSAGES_DIR, "channels");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Priority = "urgent" | "normal" | "low";

export interface Message {
    id: string;
    from: string;
    to: string[];
    priority: Priority;
    tags: string[];
    body: string;
    createdAt: string;
    readBy: Record<string, string>; // sessionId → ISO timestamp
    replyTo?: string; // parent message ID for threading
}

export interface MessageSummary {
    id: string;
    from: string;
    priority: Priority;
    tags: string[];
    createdAt: string;
    read: boolean;
    snippet: string;
    replyTo?: string;
}

export interface Channel {
    name: string;
    description?: string;
    members: string[];
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function ensureMessageDirs(): Promise<void> {
    await mkdir(MESSAGES_DIR, { recursive: true });
    await mkdir(CHANNELS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendOptions {
    from: string;
    to: string | string[];
    body: string;
    priority?: Priority;
    tags?: string[];
    replyTo?: string;
}

/**
 * Send a message. Resolves channel names (prefixed with #) to member lists.
 * Returns the message ID.
 */
export async function send(opts: SendOptions): Promise<Message> {
    const rawTo = Array.isArray(opts.to) ? opts.to : [opts.to];
    const resolvedTo: string[] = [];

    for (const target of rawTo) {
        if (target.startsWith("#")) {
            const ch = await getChannel(target.slice(1));
            if (ch) resolvedTo.push(...ch.members);
            else resolvedTo.push(target); // leave unresolved channel as-is
        } else {
            resolvedTo.push(target);
        }
    }

    // Deduplicate, exclude sender from recipients.
    const to = [...new Set(resolvedTo)].filter((id) => id !== opts.from);

    const msg: Message = {
        id: `msg_${randomUUID().slice(0, 12)}`,
        from: opts.from,
        to,
        priority: opts.priority ?? "normal",
        tags: opts.tags ?? [],
        body: opts.body,
        createdAt: new Date().toISOString(),
        readBy: {},
        replyTo: opts.replyTo,
    };

    await writeMessage(msg);
    return msg;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface InboxOptions {
    sessionId: string;
    unreadOnly?: boolean;
    includeLow?: boolean;
    tag?: string;
    since?: string;
    limit?: number;
}

/**
 * List messages addressed to a session, newest first.
 */
export async function inbox(opts: InboxOptions): Promise<MessageSummary[]> {
    const all = await readAllMessages();
    const limit = opts.limit ?? 50;

    const results: MessageSummary[] = [];
    for (const msg of all) {
        if (!msg.to.includes(opts.sessionId) && !msg.to.includes("#all")) continue;
        if (opts.unreadOnly && msg.readBy[opts.sessionId]) continue;
        if (!opts.includeLow && msg.priority === "low" && opts.unreadOnly) continue;
        if (opts.tag && !msg.tags.includes(opts.tag)) continue;
        if (opts.since && msg.createdAt < opts.since) continue;

        results.push({
            id: msg.id,
            from: msg.from,
            priority: msg.priority,
            tags: msg.tags,
            createdAt: msg.createdAt,
            read: !!msg.readBy[opts.sessionId],
            snippet: msg.body.slice(0, 120).replace(/\n/g, " "),
            replyTo: msg.replyTo,
        });

        if (results.length >= limit) break;
    }

    return results;
}

// ---------------------------------------------------------------------------
// Read / Mark Read
// ---------------------------------------------------------------------------

export async function read(messageId: string, sessionId?: string): Promise<Message | null> {
    const msg = await readMessage(messageId);
    if (!msg) return null;

    // Auto-mark as read when a specific session reads it.
    if (sessionId && !msg.readBy[sessionId]) {
        msg.readBy[sessionId] = new Date().toISOString();
        await writeMessage(msg);
    }

    return msg;
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

export interface ReplyOptions {
    messageId: string;
    from: string;
    body: string;
    priority?: Priority;
    tags?: string[];
}

/**
 * Reply to a message. Creates a new message with `replyTo` set, addressed
 * to all original recipients (minus the replier) plus the original sender.
 */
export async function reply(opts: ReplyOptions): Promise<Message | null> {
    const original = await readMessage(opts.messageId);
    if (!original) return null;

    // Reply goes to original sender + all original recipients.
    const to = [original.from, ...original.to];

    return send({
        from: opts.from,
        to,
        body: opts.body,
        priority: opts.priority ?? original.priority,
        tags: opts.tags ?? original.tags,
        replyTo: opts.messageId,
    });
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * Get all messages in a thread (original + replies), ordered chronologically.
 */
export async function thread(messageId: string): Promise<Message[]> {
    const all = await readAllMessages();
    // Find the root — walk up replyTo chain.
    let rootId = messageId;
    const byId = new Map(all.map((m) => [m.id, m]));
    while (true) {
        const msg = byId.get(rootId);
        if (!msg?.replyTo) break;
        rootId = msg.replyTo;
    }
    // Collect root + all descendants.
    const inThread = all.filter((m) => m.id === rootId || m.replyTo === rootId);
    return inThread;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannel(name: string): Promise<Channel | null> {
    const path = join(CHANNELS_DIR, `${name}.json`);
    try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw) as Channel;
    } catch {
        return null;
    }
}

export async function listChannels(): Promise<Channel[]> {
    try {
        const files = await readdir(CHANNELS_DIR);
        const channels: Channel[] = [];
        for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
                const raw = await readFile(join(CHANNELS_DIR, f), "utf8");
                channels.push(JSON.parse(raw));
            } catch { /* skip corrupt */ }
        }
        return channels;
    } catch {
        return [];
    }
}

export async function saveChannel(ch: Channel): Promise<void> {
    await mkdir(CHANNELS_DIR, { recursive: true });
    await writeFile(join(CHANNELS_DIR, `${ch.name}.json`), JSON.stringify(ch, null, 2) + "\n");
}

export async function joinChannel(channelName: string, sessionId: string): Promise<Channel> {
    let ch = await getChannel(channelName);
    if (!ch) ch = { name: channelName, members: [] };
    if (!ch.members.includes(sessionId)) {
        ch.members.push(sessionId);
        await saveChannel(ch);
    }
    return ch;
}

export async function leaveChannel(channelName: string, sessionId: string): Promise<void> {
    const ch = await getChannel(channelName);
    if (!ch) return;
    ch.members = ch.members.filter((id) => id !== sessionId);
    await saveChannel(ch);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function messagePath(id: string): string {
    return join(MESSAGES_DIR, `${id}.md`);
}

function toMarkdown(msg: Message): string {
    const fm = [
        "---",
        `id: ${msg.id}`,
        `from: ${msg.from}`,
        `to: [${msg.to.map((t) => `"${t}"`).join(", ")}]`,
        `priority: ${msg.priority}`,
        `tags: [${msg.tags.map((t) => `"${t}"`).join(", ")}]`,
        `created: ${msg.createdAt}`,
        `read_by:`,
        ...Object.entries(msg.readBy).map(([k, v]) => `  ${k}: "${v}"`),
        ...(msg.replyTo ? [`reply_to: ${msg.replyTo}`] : []),
        "---",
        "",
    ];
    return fm.join("\n") + msg.body + "\n";
}

function parseMarkdown(raw: string): Message | null {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch?.[1] || fmMatch[2] === undefined) return null;

    const fm = fmMatch[1];
    const body = fmMatch[2].trim();

    const get = (key: string): string => {
        const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
        return m?.[1]?.trim() ?? "";
    };

    const getArray = (key: string): string[] => {
        const val = get(key);
        const m = val.match(/\[(.*)]/);
        if (!m?.[1]) return [];
        return m[1]
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""))
            .filter(Boolean);
    };

    // Parse read_by block (indented key-value pairs after "read_by:")
    const readBy: Record<string, string> = {};
    const rbMatch = fm.match(/read_by:\n((?:\s+\S.*\n?)*)/);
    if (rbMatch?.[1]) {
        for (const line of rbMatch[1].split("\n")) {
            const kv = line.trim().match(/^(\S+):\s*"?(.+?)"?$/);
            if (kv?.[1] && kv[2]) readBy[kv[1]] = kv[2];
        }
    }

    const id = get("id");
    if (!id) return null;

    return {
        id,
        from: get("from"),
        to: getArray("to"),
        priority: (get("priority") || "normal") as Priority,
        tags: getArray("tags"),
        body,
        createdAt: get("created"),
        readBy,
        replyTo: get("reply_to") || undefined,
    };
}

async function writeMessage(msg: Message): Promise<void> {
    await mkdir(MESSAGES_DIR, { recursive: true });
    await writeFile(messagePath(msg.id), toMarkdown(msg));
}

async function readMessage(id: string): Promise<Message | null> {
    try {
        const raw = await readFile(messagePath(id), "utf8");
        return parseMarkdown(raw);
    } catch {
        return null;
    }
}

async function readAllMessages(): Promise<Message[]> {
    try {
        const files = await readdir(MESSAGES_DIR);
        const messages: Message[] = [];
        for (const f of files) {
            if (!f.startsWith("msg_") || !f.endsWith(".md")) continue;
            try {
                const raw = await readFile(join(MESSAGES_DIR, f), "utf8");
                const msg = parseMarkdown(raw);
                if (msg) messages.push(msg);
            } catch { /* skip corrupt */ }
        }
        // Newest first.
        messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return messages;
    } catch {
        return [];
    }
}
