import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { verifyToken } from "./tokens.js";
import { headlessSend } from "./headlessSend.js";
import { getDisplay } from "./displayManager.js";
import type { KeepAliveManager } from "./keepAlive.js";
import type { CronScheduler } from "./crons.js";

/** Maximum request body size (64 KB — prompts should be small). */
const MAX_BODY = 64 * 1024;

interface HttpDeps {
    keepAlive: KeepAliveManager;
    crons: CronScheduler;
}

/**
 * HTTP request handler mounted on the same server as the WebSocket upgrade.
 *
 * Routes:
 *   POST /hook/:sessionId   — fire-and-forget prompt send (webhook ingress)
 *   GET  /crons             — list all cron jobs
 *   POST /crons             — create a cron job
 *   GET  /crons/:id         — get a single cron job
 *   PATCH /crons/:id        — update a cron job
 *   DELETE /crons/:id       — delete a cron job
 *   GET  /health            — lightweight health probe
 */
export function createHttpHandler(deps: HttpDeps) {
    return async (req: IncomingMessage, res: ServerResponse) => {
        try {
            await routeRequest(req, res, deps);
        } catch (err) {
            console.error("[http] unhandled error:", err);
            if (!res.headersSent) {
                json(res, 500, { ok: false, error: "internal server error" });
            }
        }
    };
}

// ── routing ──────────────────────────────────────────────────────────────

async function routeRequest(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;

    // Health probe — no auth.
    if (path === "/health" && method === "GET") {
        return json(res, 200, { ok: true });
    }

    // noVNC display viewer — no bearer auth (accessed directly in browser).
    // /display/:sessionId/ serves the noVNC client pointed at this session.
    // /display/:sessionId/websockify is handled as a WS upgrade in server.ts.
    const displayMatch = path.match(/^\/display\/([^/]+)(\/.*)?$/);
    if (displayMatch?.[1] && method === "GET") {
        const sessionId = displayMatch[1];
        const sub = displayMatch[2] ?? "/";
        const info = getDisplay(sessionId);
        if (!info) return json(res, 404, { ok: false, error: "no display for this session" });
        return serveNoVnc(req, res, sessionId, sub);
    }

    // Everything else requires bearer auth.
    const token = extractBearer(req);
    if (!token) return json(res, 401, { ok: false, error: "missing Authorization: Bearer <token>" });
    const verified = await verifyToken(token);
    if (!verified) return json(res, 401, { ok: false, error: "invalid token" });

    // POST /hook/:sessionId
    const hookMatch = path.match(/^\/hook\/([^/]+)$/);
    if (hookMatch?.[1] && method === "POST") {
        return await handleWebhook(req, res, hookMatch[1], deps);
    }

    // /crons routes
    if (path === "/crons" && method === "GET") {
        return json(res, 200, { ok: true, crons: deps.crons.list() });
    }
    if (path === "/crons" && method === "POST") {
        return await handleCronCreate(req, res, deps);
    }
    const cronMatch = path.match(/^\/crons\/([^/]+)$/);
    if (cronMatch?.[1]) {
        const cronId = cronMatch[1];
        if (method === "GET") {
            const job = deps.crons.get(cronId);
            return job
                ? json(res, 200, { ok: true, cron: job })
                : json(res, 404, { ok: false, error: "cron not found" });
        }
        if (method === "PATCH") {
            return await handleCronUpdate(req, res, cronId, deps);
        }
        if (method === "DELETE") {
            const deleted = deps.crons.delete(cronId);
            return deleted
                ? json(res, 200, { ok: true, deleted: true })
                : json(res, 404, { ok: false, error: "cron not found" });
        }
    }

    json(res, 404, { ok: false, error: "not found" });
}

// ── handlers ─────────────────────────────────────────────────────────────

async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    deps: HttpDeps,
): Promise<void> {
    const body = await readBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "body too large" });

    let prompt: string;
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("application/json")) {
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed === "string") {
                prompt = parsed;
            } else if (parsed && typeof parsed.prompt === "string") {
                prompt = parsed.prompt;
            } else {
                return json(res, 400, { ok: false, error: "JSON body must be a string or { prompt: string }" });
            }
        } catch {
            return json(res, 400, { ok: false, error: "invalid JSON" });
        }
    } else {
        prompt = body.trim();
    }

    if (!prompt) return json(res, 400, { ok: false, error: "empty prompt" });

    // Fire-and-forget: kick off the send but respond immediately.
    headlessSend(sessionId, prompt, deps.keepAlive).catch((err) => {
        console.error(`[http] webhook send failed for session ${sessionId}:`, (err as Error).message);
    });

    json(res, 202, { ok: true, sessionId, accepted: true });
}

async function handleCronCreate(
    req: IncomingMessage,
    res: ServerResponse,
    deps: HttpDeps,
): Promise<void> {
    const body = await readBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "body too large" });

    let parsed: { sessionId?: string; schedule?: string; prompt?: string };
    try {
        parsed = JSON.parse(body);
    } catch {
        return json(res, 400, { ok: false, error: "invalid JSON" });
    }

    if (!parsed.sessionId || !parsed.schedule || !parsed.prompt) {
        return json(res, 400, { ok: false, error: "required fields: sessionId, schedule, prompt" });
    }

    try {
        const job = deps.crons.create(parsed.sessionId, parsed.schedule, parsed.prompt);
        json(res, 201, { ok: true, cron: job });
    } catch (err) {
        json(res, 400, { ok: false, error: (err as Error).message });
    }
}

async function handleCronUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    cronId: string,
    deps: HttpDeps,
): Promise<void> {
    const body = await readBody(req);
    if (body === null) return json(res, 413, { ok: false, error: "body too large" });

    let patch: { schedule?: string; prompt?: string; enabled?: boolean; sessionId?: string };
    try {
        patch = JSON.parse(body);
    } catch {
        return json(res, 400, { ok: false, error: "invalid JSON" });
    }

    try {
        const job = deps.crons.update(cronId, patch);
        json(res, 200, { ok: true, cron: job });
    } catch (err) {
        json(res, (err as Error).message.includes("not found") ? 404 : 400, {
            ok: false,
            error: (err as Error).message,
        });
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function extractBearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                req.destroy();
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => resolve(null));
    });
}

// ── noVNC static file serving ────────────────────────────────────────────

const NOVNC_ROOT = "/opt/noVNC";
const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
};

/**
 * Serve noVNC static files for a session's display.
 *
 *   /display/:sessionId/           → vnc.html with websockify path auto-set
 *   /display/:sessionId/foo.js     → /opt/noVNC/foo.js
 */
async function serveNoVnc(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    sub: string,
): Promise<void> {
    // Root or trailing slash → serve vnc.html with the right websockify path.
    if (sub === "/" || sub === "") {
        // Redirect to vnc.html with autoconnect params
        const wsPath = `/display/${sessionId}/websockify`;
        const params = `autoconnect=true&resize=scale&path=${encodeURIComponent(wsPath)}`;
        res.writeHead(302, { Location: `/display/${sessionId}/vnc.html?${params}` });
        res.end();
        return;
    }

    // Strip leading slash for file lookup.
    const relPath = sub.startsWith("/") ? sub.slice(1) : sub;
    const filePath = join(NOVNC_ROOT, relPath);

    // Safety: don't escape the noVNC root.
    if (!filePath.startsWith(NOVNC_ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    try {
        const data = await fs.readFile(filePath);
        const ext = extname(filePath);
        const ct = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": ct, "Content-Length": data.length });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end("Not Found");
    }
}
