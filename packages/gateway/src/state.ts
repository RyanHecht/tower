import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

/**
 * Generic, debounced JSON store for gateway-internal state that needs to
 * survive a gateway restart. The CLI daemon persists sessions, tokens have
 * their own store; this is purely the cross-restart state the *gateway*
 * itself owns:
 *
 *   - keep-alive policies per sessionId
 *   - the router session id (so we resume the same router after a restart
 *     instead of leaking a new one each boot)
 *
 * Single-writer assumption — the gateway is one process. Writes are batched
 * via a 250ms debounce and use atomic-rename to avoid torn files.
 */

import type { KeepAlivePolicy } from "./keepAlive.js";
import type { CronJobDef } from "@tower/protocol";

export interface PersistedKeepAliveEntry {
    policy: KeepAlivePolicy;
    /** Last activity timestamp (epoch ms). Only meaningful for `idle` policies. */
    lastActivity: number;
}

export interface GatewayState {
    /** sessionId of the router, if one is in use. */
    router?: { sessionId: string };
    /** keep-alive policies keyed by CLI sessionId. */
    keepAlive: Record<string, PersistedKeepAliveEntry>;
    /** Cron jobs keyed by cronId. */
    crons: Record<string, CronJobDef>;
}

const DEFAULT_STATE: GatewayState = { keepAlive: {}, crons: {} };
const STATE_PATH = join(config.paths.data, "state.json");
const SAVE_DEBOUNCE_MS = 250;

export class StateStore {
    private state: GatewayState = structuredClone(DEFAULT_STATE);
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;
    private inflight: Promise<void> | null = null;

    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(STATE_PATH, "utf8");
            const parsed = JSON.parse(raw) as Partial<GatewayState>;
            this.state = {
                router: parsed.router,
                keepAlive: parsed.keepAlive ?? {},
                crons: parsed.crons ?? {},
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                this.state = structuredClone(DEFAULT_STATE);
                return;
            }
            console.error(`[state] failed to load ${STATE_PATH}, starting empty:`, (err as Error).message);
            this.state = structuredClone(DEFAULT_STATE);
        }
    }

    snapshot(): GatewayState {
        return structuredClone(this.state);
    }

    // ── router ──────────────────────────────────────────────────────

    getRouterSessionId(): string | undefined {
        return this.state.router?.sessionId;
    }

    setRouterSessionId(sessionId: string | null): void {
        if (sessionId == null) delete this.state.router;
        else this.state.router = { sessionId };
        this.markDirty();
    }

    // ── keep-alive ──────────────────────────────────────────────────

    getKeepAliveAll(): Record<string, PersistedKeepAliveEntry> {
        return { ...this.state.keepAlive };
    }

    setKeepAlive(sessionId: string, entry: PersistedKeepAliveEntry | null): void {
        if (entry === null) delete this.state.keepAlive[sessionId];
        else this.state.keepAlive[sessionId] = entry;
        this.markDirty();
    }

    // ── crons ───────────────────────────────────────────────────────

    getCronAll(): Record<string, CronJobDef> {
        return { ...this.state.crons };
    }

    getCron(cronId: string): CronJobDef | undefined {
        return this.state.crons[cronId];
    }

    setCron(cronId: string, job: CronJobDef | null): void {
        if (job === null) delete this.state.crons[cronId];
        else this.state.crons[cronId] = job;
        this.markDirty();
    }

    // ── persistence ─────────────────────────────────────────────────

    /** Force an immediate save (used on shutdown). */
    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.inflight) await this.inflight;
        if (this.dirty) await this.write();
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.inflight = this.write().catch((err) => {
                console.error("[state] save failed:", (err as Error).message);
            });
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }

    private async write(): Promise<void> {
        this.dirty = false;
        const tmp = `${STATE_PATH}.tmp`;
        await fs.mkdir(dirname(STATE_PATH), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        await fs.rename(tmp, STATE_PATH);
    }
}
