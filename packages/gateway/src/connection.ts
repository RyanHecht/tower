import type { WebSocket } from "ws";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { Inbound, PermissionMode } from "@tower/protocol";
import { isPermissionMode } from "@tower/protocol";
import { getCopilotClient } from "./copilot.js";
import { buildPolicy } from "./permissions.js";
import { parseRules, RuleParseError, type ParsedRule } from "./rules.js";
import { resolveWorkspace } from "./workspaces.js";
import { verifyToken, type VerifiedToken } from "./tokens.js";
import type { Router } from "./router.js";
import { attachedSessions } from "./attached.js";
import {
    answerPermission,
    fanoutPrompt,
    forceDetach,
    getSession,
    register,
    type Subscription,
} from "./sessionAttachments.js";
import { KeepAliveManager, type KeepAlivePolicy } from "./keepAlive.js";

interface InboundBase {
    type: string;
    id?: string | number;
}

export function handleConnection(ws: WebSocket, remote: string, router: Router | null, keepAlive: KeepAliveManager): void {
    let auth: VerifiedToken | null = null;
    /** sessionId -> our subscription handle (for detaching on close). */
    const subs = new Map<string, Subscription>();

    const send = (msg: unknown) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    const respond = (id: string | number | undefined, ok: boolean, payload: unknown) => {
        send({ type: "result", id, ok, ...(ok ? { data: payload } : { error: payload }) });
    };

    const subscriber = { send };

    /** Drop our subscription on `sessionId` (if any). */
    const detachLocal = async (sessionId: string) => {
        const sub = subs.get(sessionId);
        if (!sub) return;
        subs.delete(sessionId);
        await sub.detach();
    };

    /**
     * Build a permission policy whose prompts fan out to every current
     * subscriber of `sessionId`. The handler returned here is what the SDK
     * call site (createSession / resumeSession) wires into
     * `onPermissionRequest`.
     */
    const buildSessionPolicy = (sessionId: string, mode: PermissionMode, allow: ParsedRule[], deny: ParsedRule[]) =>
        buildPolicy(
            { mode, allow, deny },
            { onPrompt: (pending) => fanoutPrompt(sessionId, pending) },
        );

    const handle = async (msg: Inbound): Promise<void> => {
        // First message must be `hello` with a valid bearer token.
        if (!auth) {
            if (msg.type !== "hello") {
                respond((msg as InboundBase).id, false, "unauthorized: send { type: 'hello', token } first");
                ws.close(4401, "unauthorized");
                return;
            }
            const verified = await verifyToken(msg.token);
            if (!verified) {
                send({ type: "result", ok: false, error: "invalid token" });
                ws.close(4401, "unauthorized");
                return;
            }
            auth = verified;
            console.log(`[gateway] ${remote} authed as token=${auth.id} (${auth.label})`);
            send({ type: "ready" });
            return;
        }

        switch (msg.type) {
            case "hello":
                respond(undefined, false, "already authenticated");
                return;

            case "session.create": {
                const mode: PermissionMode = isPermissionMode(msg.permissionMode) ? msg.permissionMode : "prompt";
                let allow: ParsedRule[];
                let deny: ParsedRule[];
                let kaPolicy: KeepAlivePolicy;
                try {
                    allow = parseRules(msg.allow);
                    deny = parseRules(msg.deny);
                    kaPolicy = KeepAliveManager.parsePolicy(msg.keepAlive);
                } catch (err) {
                    return respond(msg.id, false, err instanceof RuleParseError ? err.message : (err as Error).message);
                }
                try {
                    const cwd = await resolveWorkspace(msg.workspace);
                    const client = await getCopilotClient();
                    // Build the policy first; sessionId only exists post-create
                    // so we wire its onPermissionRequest via a closure that
                    // captures the handler.
                    let handler: ((req: PermissionRequest) => Promise<PermissionRequestResult>) | null = null;
                    const session = await client.createSession({
                        ...(msg.model ? { model: msg.model } : {}),
                        workingDirectory: cwd,
                        onPermissionRequest: (req) => handler!(req),
                    });
                    const policy = buildSessionPolicy(session.sessionId, mode, allow, deny);
                    handler = policy.handler;
                    const { subscription, reusedExisting } = register({
                        sessionId: session.sessionId,
                        session,
                        policy,
                        subscriber,
                    });
                    if (reusedExisting) {
                        // Extremely unlikely (fresh session id collided with
                        // an in-memory entry), but we own the SDK handle we
                        // just created and need to release it.
                        try { await session.disconnect(); } catch { /* ignore */ }
                    }
                    subs.set(session.sessionId, subscription);
                    subscription.replayPending();
                    keepAlive.apply(session.sessionId, kaPolicy);
                    respond(msg.id, true, {
                        sessionId: session.sessionId,
                        workspace: msg.workspace,
                        cwd,
                        permissionMode: mode,
                        allow: allow.map((r) => r.raw),
                        deny: deny.map((r) => r.raw),
                        keepAlive: kaPolicy,
                    });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.resume": {
                const mode: PermissionMode = isPermissionMode(msg.permissionMode) ? msg.permissionMode : "prompt";
                let allow: ParsedRule[];
                let deny: ParsedRule[];
                // keepAlive is optional on resume — undefined means "leave whatever
                // policy is already installed alone". An explicit value replaces it.
                let kaPolicy: KeepAlivePolicy | undefined;
                try {
                    allow = parseRules(msg.allow);
                    deny = parseRules(msg.deny);
                    if (msg.keepAlive !== undefined) kaPolicy = KeepAliveManager.parsePolicy(msg.keepAlive);
                } catch (err) {
                    return respond(msg.id, false, err instanceof RuleParseError ? err.message : (err as Error).message);
                }
                try {
                    const existing = getSession(msg.sessionId);
                    let session;
                    let policy;
                    if (existing) {
                        // Already attached by some other connection (or the
                        // same one mid-prompt-replay). Reuse its policy and
                        // SDK handle; just register as a new subscriber.
                        session = existing;
                        policy = buildSessionPolicy(msg.sessionId, mode, allow, deny);
                        // policy is unused once register() finds an existing
                        // entry — it'll keep the original. That's fine.
                    } else {
                        const client = await getCopilotClient();
                        let handler: ((req: PermissionRequest) => Promise<PermissionRequestResult>) | null = null;
                        session = await client.resumeSession(msg.sessionId, {
                            onPermissionRequest: (req) => handler!(req),
                        });
                        policy = buildSessionPolicy(msg.sessionId, mode, allow, deny);
                        handler = policy.handler;
                    }
                    const { subscription, reusedExisting } = register({
                        sessionId: msg.sessionId,
                        session,
                        policy,
                        subscriber,
                    });
                    if (reusedExisting && session !== existing) {
                        // We created a fresh SDK handle but registry already
                        // had one — release our orphan.
                        try { await session.disconnect(); } catch { /* ignore */ }
                    }
                    subs.set(msg.sessionId, subscription);
                    subscription.replayPending();
                    if (kaPolicy) keepAlive.apply(msg.sessionId, kaPolicy);
                    respond(msg.id, true, {
                        sessionId: msg.sessionId,
                        permissionMode: mode,
                        allow: allow.map((r) => r.raw),
                        deny: deny.map((r) => r.raw),
                        keepAlive: keepAlive.describe(msg.sessionId)?.policy ?? { kind: "default" },
                    });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.list": {
                try {
                    const client = await getCopilotClient();
                    const list = await client.listSessions();
                    respond(msg.id, true, list);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.listAll": {
                try {
                    const client = await getCopilotClient();
                    const list = await client.listSessions();
                    const routerSid = router?.getSessionId() ?? null;
                    const items = list.map((s) => ({
                        sessionId: s.sessionId,
                        workspace: s.context?.cwd,
                        summary: s.summary,
                        lastActivityAt: s.modifiedTime?.toISOString?.() ?? undefined,
                        isActive: attachedSessions.has(s.sessionId) || s.sessionId === routerSid,
                    }));
                    respond(msg.id, true, items);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.history": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const events = await session.getMessages();
                    respond(msg.id, true, { sessionId: msg.sessionId, events });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.send": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(undefined, false, `not attached to session ${msg.sessionId}`);
                keepAlive.touch(msg.sessionId);
                try {
                    await session.send({ prompt: msg.prompt });
                } catch (err) {
                    send({ type: "event", sessionId: msg.sessionId, event: { type: "session.error", data: { message: (err as Error).message } } });
                }
                return;
            }

            case "session.abort": {
                const session = getSession(msg.sessionId);
                if (!session) return;
                try { await session.abort(); } catch { /* ignore */ }
                return;
            }

            case "session.keepAlive": {
                let kaPolicy: KeepAlivePolicy;
                try {
                    kaPolicy = KeepAliveManager.parsePolicy(msg.keepAlive);
                } catch (err) {
                    return respond(msg.id, false, (err as Error).message);
                }
                keepAlive.apply(msg.sessionId, kaPolicy);
                respond(msg.id, true, { sessionId: msg.sessionId, keepAlive: kaPolicy });
                return;
            }

            case "session.delete": {
                try {
                    // Drop our subscriber + force-tear-down the registry
                    // entry (cancels any pending prompts), then delete on the
                    // daemon and clear keep-alive state.
                    subs.delete(msg.sessionId);
                    await forceDetach(msg.sessionId);
                    keepAlive.clear(msg.sessionId);
                    const client = await getCopilotClient();
                    await client.deleteSession(msg.sessionId);
                    respond(msg.id, true, { sessionId: msg.sessionId, deleted: true });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "permission.reply": {
                answerPermission(msg.requestId, msg.decision);
                return;
            }

            case "router.ask": {
                if (!router) return respond(msg.id, false, "router not available on this daemon");
                try {
                    const decision = await router.ask(msg.prompt);
                    respond(msg.id, true, decision);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "router.info": {
                respond(msg.id, true, { sessionId: router?.getSessionId() ?? null });
                return;
            }

            default:
                respond((msg as InboundBase).id, false, `unknown message type: ${(msg as InboundBase).type}`);
        }
    };

    ws.on("message", (raw) => {
        let parsed: Inbound;
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            send({ type: "result", ok: false, error: "invalid JSON" });
            return;
        }
        handle(parsed).catch((err) => {
            console.error("[gateway] unhandled error in handler:", err);
            send({ type: "result", ok: false, error: (err as Error).message });
        });
    });

    ws.on("close", () => {
        console.log(`[gateway] ${remote} disconnected (auth=${auth?.id ?? "-"})`);
        // Detach this WS from each session — the registry keeps the SDK
        // handle and policy alive if work remains (other subscribers, or
        // pending permission prompts awaiting an answer).
        for (const id of Array.from(subs.keys())) void detachLocal(id);
    });

    ws.on("error", (err) => {
        console.error(`[gateway] ws error from ${remote}:`, err);
    });
}
