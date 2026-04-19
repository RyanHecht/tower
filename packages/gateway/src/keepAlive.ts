import type { CopilotClient } from "@github/copilot-sdk";
import type { KeepAlivePolicy } from "@tower/protocol";
import type { StateStore } from "./state.js";

export type { KeepAlivePolicy } from "@tower/protocol";

/** How often we ping the daemon to defeat its idle reaper. */
const PING_INTERVAL_MS = 25 * 60 * 1000;
/** Conservative estimate of the CLI server's reap window — must be < 30min. */
const CLI_REAP_GUARD_MS = 25 * 60 * 1000;

interface Entry {
    policy: KeepAlivePolicy;
    lastActivity: number;
    pingTimer: NodeJS.Timeout | null;
    expiryTimer: NodeJS.Timeout | null;
}

export class KeepAliveManager {
    private entries = new Map<string, Entry>();
    private stopped = false;

    constructor(private client: CopilotClient, private store: StateStore) {}

    /** Parse the wire form into a policy or throw. */
    static parsePolicy(input: unknown): KeepAlivePolicy {
        if (input === undefined || input === null || input === "default") return { kind: "default" };
        if (input === "forever") return { kind: "forever" };
        if (typeof input === "object" && input !== null && "idleMs" in input) {
            const ms = Number((input as { idleMs: unknown }).idleMs);
            if (!Number.isFinite(ms) || ms <= 0) throw new Error("keepAlive.idleMs must be a positive number of milliseconds");
            return { kind: "idle", idleMs: ms };
        }
        throw new Error('keepAlive must be "default", "forever", or { idleMs: <ms> }');
    }

    /**
     * Restore policies from disk on startup. Drops any session that no longer
     * exists on the daemon; expires-on-arrival any `idle` session whose window
     * has already elapsed during downtime.
     */
    async hydrate(): Promise<void> {
        const persisted = this.store.getKeepAliveAll();
        if (Object.keys(persisted).length === 0) return;

        let liveIds: Set<string>;
        try {
            const list = await this.client.listSessions();
            liveIds = new Set(list.map((s) => s.sessionId));
        } catch (err) {
            console.error("[keepAlive] hydrate: listSessions failed, leaving policies untouched:", (err as Error).message);
            return;
        }

        for (const [sid, persistedEntry] of Object.entries(persisted)) {
            if (!liveIds.has(sid)) {
                console.log(`[keepAlive] hydrate: session ${sid} no longer exists on daemon — dropping policy`);
                this.store.setKeepAlive(sid, null);
                continue;
            }
            const { policy, lastActivity } = persistedEntry;
            if (policy.kind === "default") {
                this.store.setKeepAlive(sid, null);
                continue;
            }

            // For idle policies, account for time spent during gateway downtime.
            if (policy.kind === "idle") {
                const elapsed = Date.now() - lastActivity;
                if (elapsed >= policy.idleMs) {
                    console.log(`[keepAlive] hydrate: session ${sid} expired during downtime (${elapsed}ms idle) — deleting`);
                    this.store.setKeepAlive(sid, null);
                    try { await this.client.deleteSession(sid); } catch (err) {
                        console.error(`[keepAlive] hydrate: deleteSession ${sid} failed:`, (err as Error).message);
                    }
                    continue;
                }
            }

            const entry: Entry = {
                policy,
                lastActivity,
                pingTimer: null,
                expiryTimer: null,
            };
            this.entries.set(sid, entry);
            this.schedule(sid, entry);
        }
        console.log(`[keepAlive] hydrated ${this.entries.size} session policies`);
    }

    /** Install or replace the policy for a session. Idempotent. */
    apply(sessionId: string, policy: KeepAlivePolicy): void {
        if (this.stopped) return;
        const existing = this.entries.get(sessionId);
        if (existing) this.clearTimers(existing);

        if (policy.kind === "default") {
            this.entries.delete(sessionId);
            this.store.setKeepAlive(sessionId, null);
            return;
        }

        const entry: Entry = {
            policy,
            lastActivity: Date.now(),
            pingTimer: null,
            expiryTimer: null,
        };
        this.entries.set(sessionId, entry);
        this.schedule(sessionId, entry);
        this.persist(sessionId, entry);
    }

    /** Bump the last-activity stamp; reschedule the expiry timer if any. */
    touch(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (!entry) return;
        entry.lastActivity = Date.now();
        if (entry.policy.kind === "idle") {
            if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
            entry.expiryTimer = setTimeout(() => void this.expire(sessionId), entry.policy.idleMs);
            entry.expiryTimer.unref?.();
        }
        this.persist(sessionId, entry);
    }

    /** Forget a session entirely (e.g., after explicit delete). */
    clear(sessionId: string): void {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            // Still scrub from disk in case it was loaded but never installed
            // (e.g., expired during hydrate).
            this.store.setKeepAlive(sessionId, null);
            return;
        }
        this.clearTimers(entry);
        this.entries.delete(sessionId);
        this.store.setKeepAlive(sessionId, null);
    }

    /** Snapshot for diagnostics / status frames. */
    describe(sessionId: string): { policy: KeepAlivePolicy; idleMs: number } | null {
        const entry = this.entries.get(sessionId);
        if (!entry) return null;
        return { policy: entry.policy, idleMs: Date.now() - entry.lastActivity };
    }

    /** Stop all timers; called on shutdown. Does not delete CLI sessions. */
    stop(): void {
        this.stopped = true;
        for (const entry of this.entries.values()) this.clearTimers(entry);
        this.entries.clear();
    }

    // ── internals ────────────────────────────────────────────────────

    private persist(sessionId: string, entry: Entry): void {
        this.store.setKeepAlive(sessionId, { policy: entry.policy, lastActivity: entry.lastActivity });
    }

    private schedule(sessionId: string, entry: Entry): void {
        const needsPing =
            entry.policy.kind === "forever" ||
            (entry.policy.kind === "idle" && entry.policy.idleMs > CLI_REAP_GUARD_MS);

        if (needsPing) {
            entry.pingTimer = setInterval(() => void this.ping(sessionId), PING_INTERVAL_MS);
            entry.pingTimer.unref?.();
        }

        if (entry.policy.kind === "idle") {
            const remaining = Math.max(0, entry.policy.idleMs - (Date.now() - entry.lastActivity));
            entry.expiryTimer = setTimeout(() => void this.expire(sessionId), remaining);
            entry.expiryTimer.unref?.();
        }
    }

    private clearTimers(entry: Entry): void {
        if (entry.pingTimer) clearInterval(entry.pingTimer);
        if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
        entry.pingTimer = null;
        entry.expiryTimer = null;
    }

    private async ping(sessionId: string): Promise<void> {
        if (!this.entries.has(sessionId)) return;
        try {
            // Resuming a session bumps `sessionLastActivity` server-side without
            // injecting any user turn. We immediately disconnect this transient
            // SDK handle; the CLI session itself stays alive and any other
            // attached client is unaffected.
            const handle = await this.client.resumeSession(sessionId, {
                onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
            });
            try { await handle.disconnect(); } catch { /* ignore */ }
        } catch (err) {
            console.error(`[keepAlive] ping failed for ${sessionId} — clearing policy:`, (err as Error).message);
            this.clear(sessionId);
        }
    }

    private async expire(sessionId: string): Promise<void> {
        const entry = this.entries.get(sessionId);
        if (!entry || entry.policy.kind !== "idle") return;
        const idle = Date.now() - entry.lastActivity;
        // Race guard: if a touch came in just before this fired, reschedule.
        if (idle < entry.policy.idleMs) {
            entry.expiryTimer = setTimeout(() => void this.expire(sessionId), entry.policy.idleMs - idle);
            entry.expiryTimer.unref?.();
            return;
        }
        console.log(`[keepAlive] session ${sessionId} idle for ${idle}ms — deleting`);
        this.clear(sessionId);
        try {
            await this.client.deleteSession(sessionId);
        } catch (err) {
            console.error(`[keepAlive] deleteSession failed for ${sessionId}:`, (err as Error).message);
        }
    }
}
