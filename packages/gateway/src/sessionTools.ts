import type { Tool } from "@github/copilot-sdk";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { launchDisplay, getDisplay, destroyDisplay } from "./displayManager.js";
import { setDisplayUrl } from "./sessionAttachments.js";
import { config } from "./config.js";
import type { StateStore } from "./state.js";

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

export function buildSessionTools(store: StateStore): Tool[] {
    return [
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
    ];
}
