import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
    EventMessage,
    Inbound,
    InboundType,
    Outbound,
    PermissionRequestMessage,
    ResultMessage,
} from "@tower/protocol";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export interface ClientOptions {
    url: string;
    token: string;
    /** Per-request timeout in ms. */
    requestTimeoutMs?: number;
}

/**
 * Thin WS wrapper around the @tower/protocol wire format.
 *
 * - `connect()` resolves once the gateway has acknowledged auth with `ready`.
 * - `request(type, payload)` resolves with `result.data` for the matching `id`,
 *   rejects with `result.error`.
 * - Unsolicited messages (`event`, `permission.request`) are emitted on the
 *   instance (TowerClient extends EventEmitter).
 *
 * Events emitted:
 *   - "ready"               (no payload)
 *   - "event"               (EventMessage)
 *   - "permission.request"  (PermissionRequestMessage)
 *   - "close"               (no payload)
 *   - "error"               (Error)
 */
export class TowerClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private nextId = 1;
    private pending = new Map<string | number, PendingRequest>();
    private readyPromise: Promise<void> | null = null;
    private readonly requestTimeoutMs: number;

    constructor(private readonly opts: ClientOptions) {
        super();
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    }

    connect(): Promise<void> {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this.opts.url);
            this.ws = ws;
            let settled = false;

            ws.on("open", () => {
                ws.send(JSON.stringify({ type: "hello", token: this.opts.token } satisfies Inbound));
            });

            ws.on("message", (raw) => {
                let msg: Outbound;
                try {
                    msg = JSON.parse(raw.toString()) as Outbound;
                } catch {
                    return;
                }
                if (msg.type === "ready") {
                    settled = true;
                    this.emit("ready");
                    resolve();
                    return;
                }
                this.dispatch(msg);
            });

            ws.on("close", (code, reason) => {
                if (!settled) {
                    reject(new Error(`gateway closed before ready (code=${code} reason=${reason.toString() || "?"})`));
                }
                this.emit("close");
                for (const p of this.pending.values()) {
                    clearTimeout(p.timer);
                    p.reject(new Error("connection closed"));
                }
                this.pending.clear();
            });

            ws.on("error", (err) => {
                if (!settled) reject(err);
                this.emit("error", err);
            });
        });
        return this.readyPromise;
    }

    private dispatch(msg: Outbound): void {
        switch (msg.type) {
            case "result": {
                const r = msg as ResultMessage;
                if (r.id === undefined) return;
                const pending = this.pending.get(r.id);
                if (!pending) return;
                this.pending.delete(r.id);
                clearTimeout(pending.timer);
                if (r.ok) pending.resolve(r.data);
                else pending.reject(new Error(typeof r.error === "string" ? r.error : "request failed"));
                return;
            }
            case "event":
                this.emit("event", msg as EventMessage);
                return;
            case "permission.request":
                this.emit("permission.request", msg as PermissionRequestMessage);
                return;
            default:
                return;
        }
    }

    /**
     * Send a request frame and wait for the matching `result`.
     *
     * `type` must be one that carries an `id` field (everything except
     * `hello`, `session.send`, `session.abort`, `permission.reply`).
     */
    request<T = unknown>(
        type: Exclude<InboundType, "hello" | "session.send" | "session.abort" | "permission.reply">,
        payload: Record<string, unknown> = {},
    ): Promise<T> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("not connected"));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`request ${type} (id=${id}) timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
            });
            this.ws!.send(JSON.stringify({ type, id, ...payload }));
        });
    }

    /** Fire-and-forget for frames that do not produce a `result`. */
    notify(msg: Inbound): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }

    close(): void {
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* ignore */
            }
        }
    }
}
