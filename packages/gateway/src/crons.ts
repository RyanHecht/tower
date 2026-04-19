import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { CronJobDef } from "@tower/protocol";
import type { StateStore } from "./state.js";
import { headlessSend } from "./headlessSend.js";
import type { KeepAliveManager } from "./keepAlive.js";

/** Consecutive failures before a job is auto-disabled. */
const MAX_FAILURES = 5;

interface RunningJob {
    def: CronJobDef;
    timer: NodeJS.Timeout | null;
}

/**
 * Cron scheduler that fires prompts into sessions on a schedule.
 *
 * Each job computes its next fire time from the cron expression and sets a
 * precise `setTimeout`. On fire: send the prompt headlessly, persist the
 * updated `lastRunAt`, reschedule. On failure: bump `failCount` and
 * auto-disable after MAX_FAILURES.
 */
export class CronScheduler {
    private jobs = new Map<string, RunningJob>();
    private stopped = false;

    constructor(
        private store: StateStore,
        private keepAlive: KeepAliveManager,
    ) {}

    // ── lifecycle ────────────────────────────────────────────────────

    /** Restore jobs from state on startup. */
    hydrate(): void {
        const all = this.store.getCronAll();
        for (const def of Object.values(all)) {
            this.scheduleJob(def);
        }
        const enabled = [...this.jobs.values()].filter((j) => j.def.enabled).length;
        if (this.jobs.size > 0) {
            console.log(`[cron] hydrated ${this.jobs.size} job(s) (${enabled} enabled)`);
        }
    }

    stop(): void {
        this.stopped = true;
        for (const job of this.jobs.values()) {
            if (job.timer) clearTimeout(job.timer);
        }
        this.jobs.clear();
    }

    // ── CRUD ─────────────────────────────────────────────────────────

    create(sessionId: string, schedule: string, prompt: string): CronJobDef {
        // Validate expression eagerly.
        CronExpressionParser.parse(schedule);

        const def: CronJobDef = {
            id: randomUUID(),
            sessionId,
            schedule,
            prompt,
            enabled: true,
            createdAt: new Date().toISOString(),
            failCount: 0,
        };
        this.store.setCron(def.id, def);
        this.scheduleJob(def);
        console.log(`[cron] created job ${def.id} for session ${sessionId} schedule="${schedule}"`);
        return def;
    }

    list(): CronJobDef[] {
        return [...this.jobs.values()].map((j) => j.def);
    }

    get(cronId: string): CronJobDef | undefined {
        return this.jobs.get(cronId)?.def;
    }

    update(cronId: string, patch: { schedule?: string; prompt?: string; enabled?: boolean; sessionId?: string }): CronJobDef {
        const job = this.jobs.get(cronId);
        if (!job) throw new Error(`cron job not found: ${cronId}`);

        if (patch.schedule !== undefined) {
            CronExpressionParser.parse(patch.schedule);
            job.def.schedule = patch.schedule;
        }
        if (patch.prompt !== undefined) job.def.prompt = patch.prompt;
        if (patch.sessionId !== undefined) job.def.sessionId = patch.sessionId;
        if (patch.enabled !== undefined) {
            job.def.enabled = patch.enabled;
            // Re-enabling resets failure count.
            if (patch.enabled) {
                job.def.failCount = 0;
                job.def.lastError = undefined;
            }
        }

        this.store.setCron(cronId, job.def);
        // Reschedule with new parameters.
        if (job.timer) clearTimeout(job.timer);
        job.timer = null;
        if (job.def.enabled) this.arm(job);

        return job.def;
    }

    delete(cronId: string): boolean {
        const job = this.jobs.get(cronId);
        if (!job) return false;
        if (job.timer) clearTimeout(job.timer);
        this.jobs.delete(cronId);
        this.store.setCron(cronId, null);
        console.log(`[cron] deleted job ${cronId}`);
        return true;
    }

    // ── internals ────────────────────────────────────────────────────

    private scheduleJob(def: CronJobDef): void {
        const job: RunningJob = { def, timer: null };
        this.jobs.set(def.id, job);
        if (def.enabled) this.arm(job);
    }

    private arm(job: RunningJob): void {
        if (this.stopped || !job.def.enabled) return;

        let next: Date;
        try {
            const interval = CronExpressionParser.parse(job.def.schedule);
            next = interval.next().toDate();
        } catch (err) {
            console.error(`[cron] invalid schedule for ${job.def.id}: ${(err as Error).message}`);
            job.def.enabled = false;
            job.def.lastError = `invalid schedule: ${(err as Error).message}`;
            this.store.setCron(job.def.id, job.def);
            return;
        }

        const delay = Math.max(0, next.getTime() - Date.now());
        job.timer = setTimeout(() => void this.fire(job), delay);
        job.timer.unref?.();
    }

    private async fire(job: RunningJob): Promise<void> {
        if (this.stopped || !job.def.enabled) return;
        const { id, sessionId, prompt } = job.def;

        try {
            await headlessSend(sessionId, prompt, this.keepAlive);
            job.def.lastRunAt = new Date().toISOString();
            job.def.failCount = 0;
            job.def.lastError = undefined;
            console.log(`[cron] fired job ${id} → session ${sessionId}`);
        } catch (err) {
            job.def.failCount += 1;
            job.def.lastError = (err as Error).message;
            console.error(`[cron] job ${id} failed (${job.def.failCount}/${MAX_FAILURES}): ${job.def.lastError}`);

            if (job.def.failCount >= MAX_FAILURES) {
                job.def.enabled = false;
                console.error(`[cron] job ${id} auto-disabled after ${MAX_FAILURES} consecutive failures`);
            }
        }

        this.store.setCron(job.def.id, job.def);
        this.arm(job);
    }
}
