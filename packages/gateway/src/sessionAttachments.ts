import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { FORWARDED_EVENT_TYPES } from "@tower/protocol";
import type { PermissionPolicy } from "./permissions.js";
import { attachedSessions } from "./attached.js";

/**
 * One open WebSocket connection's interest in a session. Used to fan out
 * SDK events and permission requests to every currently attached client.
 */
export interface Subscriber {
    send: (msg: unknown) => void;
}

/**
 * Per-CopilotSession state that survives WebSocket disconnects. The SDK
 * handle and its policy stay alive across subscriber churn — the whole
 * point of Tower is to be a long-running daemon, so a session keeps
 * processing whether or not anyone happens to be watching. Entries are
 * only torn down via `forceDetach()` (explicit `session.delete` or
 * keep-alive expiry).
 */
interface AttachmentEntry {
    sessionId: string;
    session: CopilotSession;
    policy: PermissionPolicy;
    subscribers: Set<Subscriber>;
    sdkUnsubscribers: Array<() => void>;
}

export interface Subscription {
    session: CopilotSession;
    policy: PermissionPolicy;
    /** Drop this subscriber. Tears the entry down if no work remains. */
    detach: () => Promise<void>;
    /** Re-emit any in-flight permission prompts to this subscriber. */
    replayPending: () => void;
}

const entries = new Map<string, AttachmentEntry>();

const fanout = (entry: AttachmentEntry, msg: unknown) => {
    for (const sub of entry.subscribers) {
        try {
            sub.send(msg);
        } catch (err) {
            console.error(
                `[attachments] subscriber send failed for ${entry.sessionId}:`,
                (err as Error).message,
            );
        }
    }
};

/**
 * Caller is responsible for:
 *   1. Building a `PermissionPolicy` whose `onPrompt` hook calls
 *      `fanoutPrompt(sessionId, pending)` (exported below).
 *   2. Creating the SDK handle wired to that policy's `handler`.
 *   3. Calling `register()` with both, plus the requesting subscriber.
 *
 * If an entry already exists for `sessionId` (some other client got there
 * first), the freshly-created session/policy are discarded — the caller
 * must `disconnect()` their session in that case. Returns the live
 * subscription either way.
 */
export interface RegisterArgs {
    sessionId: string;
    session: CopilotSession;
    policy: PermissionPolicy;
    subscriber: Subscriber;
}

export function register(args: RegisterArgs): { subscription: Subscription; reusedExisting: boolean } {
    let entry = entries.get(args.sessionId);
    let reusedExisting = false;

    if (entry) {
        if (entry.policy.mode !== args.policy.mode) {
            console.warn(
                `[attachments] ${args.sessionId}: subscriber wanted mode=${args.policy.mode}, keeping existing ${entry.policy.mode}`,
            );
        }
        reusedExisting = true;
    } else {
        entry = {
            sessionId: args.sessionId,
            session: args.session,
            policy: args.policy,
            subscribers: new Set(),
            sdkUnsubscribers: [],
        };
        entries.set(args.sessionId, entry);
        attachedSessions.add(args.sessionId);

        for (const evt of FORWARDED_EVENT_TYPES) {
            const e = entry;
            const listener = (event: SessionEvent) => {
                fanout(e, { type: "event", sessionId: args.sessionId, event });
            };
            const unsubscribe = args.session.on(evt as never, listener as never);
            entry.sdkUnsubscribers.push(unsubscribe);
        }
    }

    const e = entry;
    e.subscribers.add(args.subscriber);

    const detach = async () => {
        const cur = entries.get(args.sessionId);
        if (!cur) return;
        cur.subscribers.delete(args.subscriber);
        // Intentionally do NOT tear down here, even when subscribers
        // hits zero. The SDK handle keeps receiving events from any
        // in-flight turn, and a future subscriber can pick up where
        // this one left off (including answering a prompt that arrived
        // while no one was attached). Lifecycle is governed by
        // `forceDetach()` (session.delete) or keep-alive expiry.
    };

    const replayPending = () => {
        const cur = entries.get(args.sessionId);
        if (!cur) return;
        for (const pending of cur.policy.listPending()) {
            args.subscriber.send({
                type: "permission.request",
                requestId: pending.requestId,
                sessionId: args.sessionId,
                request: pending.request,
            });
        }
    };

    return {
        subscription: { session: e.session, policy: e.policy, detach, replayPending },
        reusedExisting,
    };
}

/** Hook a freshly-built policy's `onPrompt` to the registry's fanout. */
export function fanoutPrompt(
    sessionId: string,
    pending: { requestId: string; request: unknown },
): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    fanout(entry, {
        type: "permission.request",
        requestId: pending.requestId,
        sessionId,
        request: pending.request,
    });
}

async function teardown(entry: AttachmentEntry): Promise<void> {
    entries.delete(entry.sessionId);
    attachedSessions.remove(entry.sessionId);
    for (const off of entry.sdkUnsubscribers) {
        try { off(); } catch { /* ignore */ }
    }
    // Notify any subscribers still holding this entry that any pending
    // prompts they may have on screen are now moot.
    for (const pending of entry.policy.listPending()) {
        fanout(entry, {
            type: "permission.resolved",
            requestId: pending.requestId,
            sessionId: entry.sessionId,
            reason: "cancelled",
        });
    }
    entry.policy.cancelAll();
    try { await entry.session.disconnect(); } catch { /* ignore */ }
}

/** Look up the live SDK handle for routing per-session calls. */
export function getSession(sessionId: string): CopilotSession | undefined {
    return entries.get(sessionId)?.session;
}

/** Force-tear-down an entry (e.g., after explicit delete). */
export async function forceDetach(sessionId: string): Promise<void> {
    const entry = entries.get(sessionId);
    if (!entry) return;
    await teardown(entry);
}

/** Answer a permission prompt regardless of which entry holds it. Broadcasts
 *  a `permission.resolved` frame to every subscriber on success so other
 *  open dialogs (across reconnects, second TUI, etc.) can dismiss themselves. */
export function answerPermission(
    requestId: string,
    decision: "approve" | "deny",
): boolean {
    for (const entry of entries.values()) {
        if (entry.policy.answer(requestId, decision)) {
            fanout(entry, {
                type: "permission.resolved",
                requestId,
                sessionId: entry.sessionId,
                decision,
                reason: "answered",
            });
            return true;
        }
    }
    return false;
}
