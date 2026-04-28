import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

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

    // Seed core memory files if they don't exist.
    await seedFile(join(CORE_DIR, "user.md"),
        "# User\n\n(No information yet. The agent will fill this in as it learns about you.)\n");
    await seedFile(join(CORE_DIR, "preferences.md"),
        "# Preferences\n\n(No preferences recorded yet.)\n");
    await seedFile(join(CORE_DIR, "context.md"),
        "# Current Context\n\n(No active context.)\n");

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
    const path = join(CORE_DIR, `${section}.md`);
    await writeFile(path, content);
    await gitCommitAll(`core: update ${section}`);
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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await gitCommitAll(commitMsg ?? `memory: update ${topicPath}`);
}

/** Append a fact to a memory file, creating it if needed. */
export async function appendToMemory(topicPath: string, fact: string, commitMsg?: string): Promise<void> {
    const path = resolveMemoryPath(topicPath);
    await mkdir(dirname(path), { recursive: true });
    let existing = "";
    try { existing = await readFile(path, "utf8"); } catch { /* new file */ }
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    const newContent = existing + separator + fact + "\n";
    await writeFile(path, newContent);
    await gitCommitAll(commitMsg ?? `memory: add fact to ${topicPath}`);
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
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
    if (!vaultName) {
        await gitCommitAll(`vault: update ${filePath}`);
    }
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
export async function vaultSearch(query: string, vaultName?: string): Promise<SearchResult[]> {
    const root = vaultName ? join(config.paths.vaults, vaultName) : VAULT;
    try {
        const { stdout } = await exec("grep", [
            "-rn", "--include=*.md", "-i",
            query, root,
        ], { maxBuffer: 1024 * 1024 });
        return stdout.split("\n").filter(Boolean).slice(0, 50).map((line) => {
            const match = line.match(/^(.+?):(\d+):(.*)$/);
            if (!match?.[1] || !match[2] || !match[3]) return { file: "", line: 0, content: line };
            return {
                file: relative(root, match[1]),
                line: parseInt(match[2], 10),
                content: match[3].trim(),
            };
        }).filter((r) => r.file);
    } catch {
        return []; // grep returns exit code 1 on no matches
    }
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
