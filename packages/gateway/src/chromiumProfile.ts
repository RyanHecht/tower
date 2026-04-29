/**
 * Chromium profile and auth-state management.
 *
 * Handles syncing login cookies, session storage, and other auth-relevant
 * files between a shared pool and per-session Chromium profile directories.
 * This lets logins accumulate across sessions automatically.
 */

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

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
export async function ensureProfileDir(sessionId: string): Promise<string> {
    const profileDir = join(config.paths.chromiumProfiles, sessionId);
    await mkdir(join(profileDir, "Default"), { recursive: true });

    // Seed from shared pool on every launch — picks up logins from other
    // sessions. Only copies auth files, not caches or session-specific state.
    const shared = config.paths.chromiumShared;
    if (existsSync(shared)) {
        const n = await syncAuthFiles(shared, profileDir);
        if (n > 0) console.log(`[chromium] synced ${n} auth files from shared pool → ${sessionId}`);
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
    if (n > 0) console.log(`[chromium] synced ${n} auth files from ${sessionId} → shared pool`);
}
