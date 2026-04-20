import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";

/**
 * Per-session virtual display manager.
 *
 * Each session that needs a headed browser gets its own Xvfb instance on a
 * unique X display number (:10, :11, …), plus a lightweight window manager
 * (fluxbox) and a VNC server (x11vnc) on 127.0.0.1:<vncPort>.
 *
 * The gateway handles VNC WebSocket proxying and noVNC static file serving
 * on its own port (8787) — no extra ports or processes needed. The noVNC
 * viewer is accessed at:
 *   http://host:8787/display/<sessionId>/
 *
 * Displays are spawned on-demand and torn down when the session is deleted
 * or the gateway shuts down.
 */

const DISPLAY_RESOLUTION = process.env.TOWER_DISPLAY_RESOLUTION ?? "1024x768x24";

/** X display numbers start at 10 to avoid collisions. */
let nextDisplayNum = 10;

interface DisplayEntry {
    sessionId: string;
    displayNum: number;
    vncPort: number;
    /** `:N` string for DISPLAY env var. */
    display: string;
    procs: ChildProcess[];
    log: WriteStream;
}

const displays = new Map<string, DisplayEntry>();

export interface DisplayInfo {
    sessionId: string;
    display: string;
    vncPort: number;
    /** Relative URL path for the noVNC viewer. */
    noVncUrl: string;
}

/**
 * Launch a virtual display for a session. Idempotent — returns existing
 * display info if one is already running.
 */
export async function launchDisplay(sessionId: string): Promise<DisplayInfo> {
    const existing = displays.get(sessionId);
    if (existing) return toInfo(existing);

    const displayNum = nextDisplayNum++;
    const display = `:${displayNum}`;
    const vncPort = 5900 + displayNum;

    const logDir = config.paths.logs;
    await mkdir(logDir, { recursive: true });
    const log = createWriteStream(`${logDir}/display-${sessionId.slice(0, 8)}.log`, { flags: "a" });
    const procs: ChildProcess[] = [];

    const spawnLogged = (cmd: string, args: string[], env?: Record<string, string>): ChildProcess => {
        const proc = spawn(cmd, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: env ? { ...process.env, ...env } : undefined,
        });
        proc.stdout?.pipe(log, { end: false });
        proc.stderr?.pipe(log, { end: false });
        procs.push(proc);
        return proc;
    };

    // 1. Xvfb
    const xvfb = spawnLogged("Xvfb", [
        display, "-screen", "0", DISPLAY_RESOLUTION, "-ac", "+extension", "GLX",
    ]);

    // Wait for Xvfb to create its socket.
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Xvfb did not start within 5s")), 5000);
        const check = setInterval(() => {
            if (existsSync(`/tmp/.X11-unix/X${displayNum}`)) {
                clearInterval(check);
                clearTimeout(timeout);
                resolve();
            }
        }, 100);
        xvfb.on("exit", (code) => {
            clearInterval(check);
            clearTimeout(timeout);
            reject(new Error(`Xvfb exited with code ${code}`));
        });
    });

    // 2. Window manager
    spawnLogged("fluxbox", [], { DISPLAY: display });

    // 3. VNC server (loopback only — gateway proxies WebSocket → TCP)
    spawnLogged("x11vnc", [
        "-display", display,
        "-nopw",
        "-listen", "127.0.0.1",
        "-forever",
        "-shared",
        "-rfbport", String(vncPort),
    ]);

    const entry: DisplayEntry = {
        sessionId,
        displayNum,
        vncPort,
        display,
        procs,
        log,
    };
    displays.set(sessionId, entry);

    console.log(`[display] launched ${display} for session ${sessionId} (vnc=${vncPort})`);
    return toInfo(entry);
}

/** Tear down a session's display. */
export async function destroyDisplay(sessionId: string): Promise<void> {
    const entry = displays.get(sessionId);
    if (!entry) return;
    displays.delete(sessionId);

    for (const proc of entry.procs.reverse()) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const proc of entry.procs) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    entry.log.end();
    console.log(`[display] destroyed ${entry.display} for session ${sessionId}`);
}

/** Get display info for a session, or undefined if none is running. */
export function getDisplay(sessionId: string): DisplayInfo | undefined {
    const entry = displays.get(sessionId);
    return entry ? toInfo(entry) : undefined;
}

/** Get the VNC port for a session (used by the WS→TCP proxy). */
export function getVncPort(sessionId: string): number | undefined {
    return displays.get(sessionId)?.vncPort;
}

/** List all active displays. */
export function listDisplays(): DisplayInfo[] {
    return [...displays.values()].map(toInfo);
}

/** Shut down all displays (gateway shutdown). */
export async function destroyAllDisplays(): Promise<void> {
    const ids = [...displays.keys()];
    await Promise.all(ids.map(destroyDisplay));
}

function toInfo(entry: DisplayEntry): DisplayInfo {
    return {
        sessionId: entry.sessionId,
        display: entry.display,
        vncPort: entry.vncPort,
        noVncUrl: `/display/${entry.sessionId}/`,
    };
}
