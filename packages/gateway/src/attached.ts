/**
 * Process-global registry of sessions currently attached by *some* WS
 * connection. Used by `session.listAll` to flag rows as active vs archived.
 *
 * A session counts as attached for as long as any open connection holds a
 * `CopilotSession` handle to it. The router's own session is *not* tracked
 * here — callers fold that in separately via `Router.getSessionId()`.
 */

const refs = new Map<string, number>();

export const attachedSessions = {
    /** Increment refcount; a session may be attached by multiple connections. */
    add(sessionId: string): void {
        refs.set(sessionId, (refs.get(sessionId) ?? 0) + 1);
    },
    /** Decrement refcount; remove when it hits zero. */
    remove(sessionId: string): void {
        const n = refs.get(sessionId);
        if (n === undefined) return;
        if (n <= 1) refs.delete(sessionId);
        else refs.set(sessionId, n - 1);
    },
    has(sessionId: string): boolean {
        return refs.has(sessionId);
    },
};
