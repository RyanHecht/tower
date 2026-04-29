import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Per-path advisory file locks
// ---------------------------------------------------------------------------

/**
 * In-process lock map. Since all sessions share the gateway process, this
 * serializes concurrent writes to the same vault file. The lock wraps the
 * full read→modify→write→git-commit cycle.
 */
const locks = new Map<string, Promise<void>>();

/** Acquire a lock on `path`, run `fn`, then release. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = path;
    // Chain onto any existing lock for this path.
    const prev = locks.get(key) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    locks.set(key, next);
    try {
        await prev;
        return await fn();
    } finally {
        release!();
        // Clean up if we're the last in the chain.
        if (locks.get(key) === next) locks.delete(key);
    }
}

/**
 * Git-backed knowledge vault.
 *
 * All knowledge lives as markdown files in `data/vault/`. The vault is a git
 * repo — every write is auto-committed with a meaningful message. This gives
 * us versioning, diffing, and temporal queries for free.
 *
 * Structure:
 *   _core/           — always injected into the session system prompt
 *     user.md        — who the user is, key facts
 *     preferences.md — how the user likes things done
 *     context.md     — current projects, goals, priorities
 *   _memory/         — searchable knowledge base (on-demand via tower_recall)
 *     topics/        — topic-based fact files
 *     people/        — per-person profiles
 *     sessions/      — auto-generated session summaries
 *   projects/        — per-session working directories
 */

const VAULT = config.paths.vault;
const CORE_DIR = join(VAULT, "_core");
const MEMORY_DIR = join(VAULT, "_memory");
const INBOX_DIR = join(VAULT, "inbox");
const SCHEMA_PATH = join(VAULT, "_schema.md");
const PROCESSED_PATH = join(INBOX_DIR, ".processed");

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** Initialize the vault on gateway boot. Idempotent. */
export async function initVault(): Promise<void> {
    // Create directory structure.
    await mkdir(CORE_DIR, { recursive: true });
    await mkdir(join(MEMORY_DIR, "topics"), { recursive: true });
    await mkdir(join(MEMORY_DIR, "people"), { recursive: true });
    await mkdir(join(MEMORY_DIR, "sessions"), { recursive: true });
    await mkdir(join(VAULT, "projects"), { recursive: true });
    await mkdir(INBOX_DIR, { recursive: true });

    // Seed core memory files if they don't exist.
    await seedFile(join(CORE_DIR, "user.md"),
        "# User\n\n(No information yet. The agent will fill this in as it learns about you.)\n");
    await seedFile(join(CORE_DIR, "preferences.md"),
        "# Preferences\n\n(No preferences recorded yet.)\n");
    await seedFile(join(CORE_DIR, "context.md"),
        "# Current Context\n\n(No active context.)\n");

    // Seed vault schema if it doesn't exist.
    await seedFile(SCHEMA_PATH, DEFAULT_SCHEMA);

    // Seed inbox README.
    await seedFile(join(INBOX_DIR, "README.md"),
        "# Vault Inbox\n\n" +
        "External data lands here before processing. Files are **immutable** —\n" +
        "once written, the source content is never modified.\n\n" +
        "Subdirectories are categories (e.g., `emails/`, `meetings/`, `messages/`).\n" +
        "Create new categories as needed.\n\n" +
        "State is tracked in `.processed` (JSONL, append-only).\n");

    // Initialize git repo if needed.
    if (!existsSync(join(VAULT, ".git"))) {
        await git("init");
        await git("config", "user.name", "Tower");
        await git("config", "user.email", "tower@localhost");
        await gitCommitAll("vault: initialize");
        console.log("[vault] initialized git repo");
    }

    console.log(`[vault] ready at ${VAULT}`);
}

// ---------------------------------------------------------------------------
// Core Memory (always injected)
// ---------------------------------------------------------------------------

/** Read all core memory files, concatenated. */
export async function readCoreMemory(): Promise<string> {
    const sections: string[] = [];
    for (const name of ["user.md", "preferences.md", "context.md"]) {
        const path = join(CORE_DIR, name);
        try {
            const content = await readFile(path, "utf8");
            if (content.trim()) sections.push(content.trim());
        } catch { /* skip missing */ }
    }
    return sections.join("\n\n---\n\n");
}

/** Read a single core memory section. */
export async function readCoreSection(section: string): Promise<string> {
    const path = join(CORE_DIR, `${section}.md`);
    try {
        return await readFile(path, "utf8");
    } catch {
        return "";
    }
}

/** Update a core memory section. The agent self-edits these. */
export async function updateCoreSection(section: string, content: string): Promise<void> {
    const valid = ["user", "preferences", "context"];
    if (!valid.includes(section)) throw new Error(`Invalid core section: ${section}. Must be one of: ${valid.join(", ")}`);
    const filePath = join(CORE_DIR, `${section}.md`);
    await withFileLock(filePath, async () => {
        await writeFile(filePath, content);
        await gitCommitAll(`core: update ${section}`);
    });
}

// ---------------------------------------------------------------------------
// Archival Memory (_memory/)
// ---------------------------------------------------------------------------

/** Read a memory file by topic path (e.g., "topics/tower" or "people/bob"). */
export async function readMemory(topicPath: string): Promise<string | null> {
    const path = resolveMemoryPath(topicPath);
    try {
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

/** Write a memory file. Creates parent dirs as needed. */
export async function writeMemory(topicPath: string, content: string, commitMsg?: string): Promise<void> {
    const path = resolveMemoryPath(topicPath);
    await withFileLock(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        await gitCommitAll(commitMsg ?? `memory: update ${topicPath}`);
    });
}

/** Append a fact to a memory file, creating it if needed. */
export async function appendToMemory(topicPath: string, fact: string, commitMsg?: string): Promise<void> {
    const path = resolveMemoryPath(topicPath);
    await withFileLock(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        let existing = "";
        try { existing = await readFile(path, "utf8"); } catch { /* new file */ }
        const separator = existing && !existing.endsWith("\n") ? "\n" : "";
        const newContent = existing + separator + fact + "\n";
        await writeFile(path, newContent);
        await gitCommitAll(commitMsg ?? `memory: add fact to ${topicPath}`);
    });
}

/** List all memory files. Returns paths relative to _memory/. */
export async function listMemory(subdir?: string): Promise<string[]> {
    const base = subdir ? join(MEMORY_DIR, subdir) : MEMORY_DIR;
    return await walkDir(base, MEMORY_DIR);
}

// ---------------------------------------------------------------------------
// Vault File Access (any vault)
// ---------------------------------------------------------------------------

export interface VaultFile {
    path: string;
    content: string;
}

/** Read a file from the vault or a named external vault. */
export async function vaultRead(filePath: string, vaultName?: string): Promise<string | null> {
    const absPath = resolveVaultPath(filePath, vaultName);
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return null;
    }
}

/** Write a file to the vault. Auto-commits for the main vault. */
export async function vaultWrite(filePath: string, content: string, vaultName?: string): Promise<void> {
    const absPath = resolveVaultPath(filePath, vaultName);
    await withFileLock(absPath, async () => {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content);
        if (!vaultName) {
            await gitCommitAll(`vault: update ${filePath}`);
        }
    });
}

/** Append content to a vault file. Creates the file if it doesn't exist. */
export async function vaultAppend(filePath: string, content: string, vaultName?: string): Promise<void> {
    const absPath = resolveVaultPath(filePath, vaultName);
    await withFileLock(absPath, async () => {
        await mkdir(dirname(absPath), { recursive: true });
        let existing = "";
        try { existing = await readFile(absPath, "utf8"); } catch { /* new file */ }
        const separator = existing && !existing.endsWith("\n") ? "\n" : "";
        const newContent = existing + separator + content + "\n";
        await writeFile(absPath, newContent);
        if (!vaultName) {
            await gitCommitAll(`vault: append to ${filePath}`);
        }
    });
}

/** List files in a vault directory. */
export async function vaultList(dirPath?: string, vaultName?: string): Promise<string[]> {
    const base = resolveVaultPath(dirPath ?? "", vaultName);
    const root = vaultName ? join(config.paths.vaults, vaultName) : VAULT;
    return await walkDir(base, root);
}

// ---------------------------------------------------------------------------
// Search (grep)
// ---------------------------------------------------------------------------

export interface SearchResult {
    file: string;
    line: number;
    content: string;
}

/** Grep across the vault (or a named vault) for a query string. */
export async function vaultSearch(query: string, vaultName?: string, scope?: "all" | "memory" | "inbox"): Promise<SearchResult[]> {
    const root = vaultName ? join(config.paths.vaults, vaultName) : VAULT;

    // Determine search directories based on scope.
    let searchDirs: string[];
    switch (scope) {
        case "memory":
            searchDirs = [MEMORY_DIR, CORE_DIR];
            break;
        case "inbox":
            searchDirs = [INBOX_DIR];
            break;
        default: // "all"
            searchDirs = [root];
            break;
    }

    const allResults: SearchResult[] = [];
    for (const dir of searchDirs) {
        try {
            const { stdout } = await exec("grep", [
                "-rn", "--include=*.md", "-i",
                query, dir,
            ], { maxBuffer: 1024 * 1024 });
            const results = stdout.split("\n").filter(Boolean).map((line) => {
                const match = line.match(/^(.+?):(\d+):(.*)$/);
                if (!match?.[1] || !match[2] || !match[3]) return { file: "", line: 0, content: line };
                return {
                    file: relative(root, match[1]),
                    line: parseInt(match[2], 10),
                    content: match[3].trim(),
                };
            }).filter((r) => r.file);
            allResults.push(...results);
        } catch {
            // grep returns exit code 1 on no matches
        }
    }
    return allResults.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(...args: string[]): Promise<string> {
    try {
        const { stdout } = await exec("git", ["-C", VAULT, ...args]);
        return stdout.trim();
    } catch (err) {
        const msg = (err as Error).message;
        // "nothing to commit" is not an error
        if (msg.includes("nothing to commit")) return "";
        throw err;
    }
}

async function gitCommitAll(message: string): Promise<void> {
    try {
        await git("add", "-A");
        await git("commit", "-m", message, "--allow-empty-message");
    } catch {
        // Ignore commit failures (nothing to commit, etc.)
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveMemoryPath(topicPath: string): string {
    // Ensure .md extension.
    const p = topicPath.endsWith(".md") ? topicPath : `${topicPath}.md`;
    const resolved = join(MEMORY_DIR, p);
    // Safety: don't escape _memory/.
    if (!resolved.startsWith(MEMORY_DIR)) throw new Error(`Path escapes memory directory: ${topicPath}`);
    return resolved;
}

function resolveVaultPath(filePath: string, vaultName?: string): string {
    const root = vaultName ? join(config.paths.vaults, vaultName) : VAULT;
    const resolved = join(root, filePath);
    if (!resolved.startsWith(root)) throw new Error(`Path escapes vault: ${filePath}`);
    return resolved;
}

async function walkDir(dir: string, root: string): Promise<string[]> {
    const results: string[] = [];
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.name.startsWith(".")) continue; // skip .git etc
            if (entry.isDirectory()) {
                results.push(...await walkDir(full, root));
            } else if (entry.name.endsWith(".md")) {
                results.push(relative(root, full));
            }
        }
    } catch { /* dir doesn't exist */ }
    return results;
}

async function seedFile(path: string, content: string): Promise<void> {
    if (existsSync(path)) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA = `# Vault Schema

## Structure
- \`_core/\` — always in system prompt (user.md, preferences.md, context.md)
  - Keep concise and current. REWRITE sections, don't append.
- \`_memory/topics/\` — facts organized by topic
- \`_memory/people/\` — per-person profiles
- \`_memory/sessions/\` — session summaries
- \`inbox/\` — unprocessed source items (immutable, never edit these)

## Conventions
- Filenames: lowercase, hyphens, date-prefixed where temporal
- Cross-reference with \`(see: path/to/file.md)\`
- Every fact should cite its source
`;

/** Read the vault schema. Returns empty string if missing. */
export async function readSchema(): Promise<string> {
    try {
        return await readFile(SCHEMA_PATH, "utf8");
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// Inbox State Tracking
// ---------------------------------------------------------------------------

export interface InboxItemState {
    itemId: string;
    status: "processed" | "failed";
    by: string;
    at: string;
    notes?: string;
}

/** Read all processed item IDs from the .processed JSONL file. */
async function readProcessedState(): Promise<Map<string, InboxItemState>> {
    const map = new Map<string, InboxItemState>();
    try {
        const raw = await readFile(PROCESSED_PATH, "utf8");
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line) as InboxItemState;
                map.set(entry.itemId, entry);
            } catch { /* skip malformed lines */ }
        }
    } catch { /* file doesn't exist yet */ }
    return map;
}

/** Mark an inbox item as processed or failed. Append-only. */
export async function markInboxProcessed(
    itemId: string,
    sessionId: string,
    status: "processed" | "failed",
    notes?: string,
): Promise<void> {
    await withFileLock(PROCESSED_PATH, async () => {
        const entry: InboxItemState = {
            itemId,
            status,
            by: sessionId,
            at: new Date().toISOString(),
            ...(notes ? { notes } : {}),
        };
        await mkdir(dirname(PROCESSED_PATH), { recursive: true });
        await appendFile(PROCESSED_PATH, JSON.stringify(entry) + "\n");
    });
}

export interface InboxItem {
    itemId: string;
    category: string;
    path: string;
    title: string;
    source?: string;
    createdAt?: string;
    preview: string;
}

/** List inbox items, optionally filtered by status and category. */
export async function listInboxItems(opts?: {
    category?: string;
    status?: "new" | "processed" | "failed";
    limit?: number;
}): Promise<InboxItem[]> {
    const { category, status = "new", limit = 50 } = opts ?? {};
    const processed = await readProcessedState();

    // Walk inbox/ for markdown files.
    const items: InboxItem[] = [];
    const searchDir = category ? join(INBOX_DIR, category) : INBOX_DIR;

    async function scan(dir: string): Promise<void> {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await scan(full);
            } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
                const relPath = relative(VAULT, full);
                const itemId = entry.name.replace(/\.md$/, "");
                const cat = relative(INBOX_DIR, dir) || "uncategorized";
                const state = processed.get(itemId);

                // Filter by status.
                if (status === "new" && state) continue;
                if (status === "processed" && state?.status !== "processed") continue;
                if (status === "failed" && state?.status !== "failed") continue;

                // Read preview.
                let content = "";
                try { content = await readFile(full, "utf8"); } catch { continue; }
                const preview = content.slice(0, 200);

                // Extract title from frontmatter or filename.
                const titleMatch = content.match(/^title:\s*(.+)$/m);
                const title = titleMatch?.[1] ?? itemId;

                const sourceMatch = content.match(/^source:\s*(.+)$/m);
                const dateMatch = content.match(/^date:\s*(.+)$/m);

                items.push({
                    itemId,
                    category: cat,
                    path: relPath,
                    title,
                    source: sourceMatch?.[1],
                    createdAt: dateMatch?.[1],
                    preview,
                });

                if (items.length >= limit) return;
            }
        }
    }

    await scan(searchDir);
    return items;
}

/** Check if an externalId already exists in the inbox. */
export async function findByExternalId(externalId: string): Promise<string | null> {
    // Grep for the externalId in frontmatter across inbox files.
    try {
        const { stdout } = await exec("grep", [
            "-rl", "--include=*.md",
            `externalId: ${externalId}`,
            INBOX_DIR,
        ], { maxBuffer: 1024 * 1024 });
        const first = stdout.split("\n").filter(Boolean)[0];
        return first ? relative(VAULT, first) : null;
    } catch {
        return null; // grep returns exit code 1 on no matches
    }
}

/** Write a new inbox item. Returns the itemId. */
export async function inboxAdd(opts: {
    body: string;
    source: string;
    category: string;
    title?: string;
    externalId?: string;
}): Promise<{ itemId: string; path: string; duplicate: boolean }> {
    const { body, source, category, title, externalId } = opts;

    // Normalize category.
    const cat = category.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const catDir = join(INBOX_DIR, cat);
    await mkdir(catDir, { recursive: true });

    // Check idempotency.
    if (externalId) {
        const existing = await findByExternalId(externalId);
        if (existing) {
            const itemId = existing.split("/").pop()?.replace(/\.md$/, "") ?? "";
            return { itemId, path: existing, duplicate: true };
        }
    }

    // Generate filename.
    const date = new Date().toISOString().slice(0, 10);
    const slug = title
        ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
        : Math.random().toString(36).slice(2, 10);
    let filename = `${date}-${slug}.md`;
    // Avoid collisions.
    let counter = 1;
    while (existsSync(join(catDir, filename))) {
        filename = `${date}-${slug}-${counter}.md`;
        counter++;
    }

    const itemId = filename.replace(/\.md$/, "");
    const filePath = join(catDir, filename);
    const relPath = relative(VAULT, filePath);

    // Build frontmatter.
    const frontmatter = [
        "---",
        `title: ${title ?? slug}`,
        `source: ${source}`,
        `date: ${new Date().toISOString()}`,
        `category: ${cat}`,
        ...(externalId ? [`externalId: ${externalId}`] : []),
        "---",
        "",
    ].join("\n");

    await writeFile(filePath, frontmatter + body);
    await gitCommitAll(`inbox: add ${cat}/${filename}`);

    return { itemId, path: relPath, duplicate: false };
}
