import type { WebSocket } from "ws";
import type { CopilotSession, PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import type { Inbound, PermissionMode } from "@tower/protocol";
import { isPermissionMode, FORWARDED_EVENT_TYPES } from "@tower/protocol";
import { getCopilotClient } from "./copilot.js";
import { buildPolicy, type PermissionPolicy } from "./permissions.js";
import { parseRules, RuleParseError, type ParsedRule } from "./rules.js";
import { resolveWorkspace } from "./workspaces.js";
import { verifyToken, type VerifiedToken } from "./tokens.js";
import type { Router } from "./router.js";
import { attachedSessions } from "./attached.js";
import { KeepAliveManager, type KeepAlivePolicy } from "./keepAlive.js";

interface InboundBase {
    type: string;
    id?: string | number;
}

interface AttachedSession {
    session: CopilotSession;
    policy: PermissionPolicy;
    /** Disposers for event listeners we registered on the session. */
    unsubscribers: Array<() => void>;
}

const FORWARDED_EVENTS = FORWARDED_EVENT_TYPES;

export function handleConnection(ws: WebSocket, remote: string, router: Router | null, keepAlive: KeepAliveManager): void {
    let auth: VerifiedToken | null = null;
    const sessions = new Map<string, AttachedSession>();

    const send = (msg: unknown) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    const respond = (id: string | number | undefined, ok: boolean, payload: unknown) => {
        send({ type: "result", id, ok, ...(ok ? { data: payload } : { error: payload }) });
    };

    const attachSession = (
        session: CopilotSession,
        mode: PermissionMode,
        allow: ParsedRule[],
        deny: ParsedRule[],
    ): AttachedSession => {
        const policy = buildPolicy({ mode, allow, deny }, {
            onPrompt: (pending) => {
                send({
                    type: "permission.request",
                    requestId: pending.requestId,
                    sessionId: session.sessionId,
                    request: pending.request,
                });
            },
        });

        const unsubscribers: Array<() => void> = [];
        for (const evt of FORWARDED_EVENTS) {
            const listener = (event: SessionEvent) => {
                send({ type: "event", sessionId: session.sessionId, event });
            };
            const unsubscribe = session.on(evt as never, listener as never);
            unsubscribers.push(unsubscribe);
        }

        const attached: AttachedSession = { session, policy, unsubscribers };
        sessions.set(session.sessionId, attached);
        attachedSessions.add(session.sessionId);
        return attached;
    };

    const detachSession = async (sessionId: string) => {
        const attached = sessions.get(sessionId);
        if (!attached) return;
        sessions.delete(sessionId);
        attachedSessions.remove(sessionId);
        attached.policy.cancelAll();
        for (const off of attached.unsubscribers) {
            try { off(); } catch { /* ignore */ }
        }
        try { await attached.session.disconnect(); } catch { /* ignore */ }
    };

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
                    const policyRef: { current: PermissionPolicy | null } = { current: null };
                    const session = await client.createSession({
                        ...(msg.model ? { model: msg.model } : {}),
                        workingDirectory: cwd,
                        onPermissionRequest: (req: PermissionRequest) => policyRef.current!.handler(req),
                    });
                    const attached = attachSession(session, mode, allow, deny);
                    policyRef.current = attached.policy;
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
                    const client = await getCopilotClient();
                    const policyRef: { current: PermissionPolicy | null } = { current: null };
                    const session = await client.resumeSession(msg.sessionId, {
                        onPermissionRequest: (req: PermissionRequest) => policyRef.current!.handler(req),
                    });
                    const attached = attachSession(session, mode, allow, deny);
                    policyRef.current = attached.policy;
                    if (kaPolicy) keepAlive.apply(session.sessionId, kaPolicy);
                    respond(msg.id, true, {
                        sessionId: session.sessionId,
                        permissionMode: mode,
                        allow: allow.map((r) => r.raw),
                        deny: deny.map((r) => r.raw),
                        keepAlive: keepAlive.describe(session.sessionId)?.policy ?? { kind: "default" },
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
                const attached = sessions.get(msg.sessionId);
                if (!attached) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const events = await attached.session.getMessages();
                    respond(msg.id, true, { sessionId: msg.sessionId, events });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.send": {
                const attached = sessions.get(msg.sessionId);
                if (!attached) return respond(undefined, false, `not attached to session ${msg.sessionId}`);
                keepAlive.touch(msg.sessionId);
                try {
                    await attached.session.send({ prompt: msg.prompt });
                } catch (err) {
                    send({ type: "event", sessionId: msg.sessionId, event: { type: "session.error", data: { message: (err as Error).message } } });
                }
                return;
            }

            case "session.abort": {
                const attached = sessions.get(msg.sessionId);
                if (!attached) return;
                try { await attached.session.abort(); } catch { /* ignore */ }
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
                    // Detach our handle first so the client side cleans up cleanly,
                    // then drop keep-alive state so we don't try to ping a dead session.
                    await detachSession(msg.sessionId);
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
                for (const attached of sessions.values()) {
                    attached.policy.answer(msg.requestId, msg.decision);
                }
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
        // Detach all sessions but DO NOT delete them — they keep running on the daemon
        // and any other connection (or this one reconnecting) can session.resume them.
        for (const id of Array.from(sessions.keys())) void detachSession(id);
    });

    ws.on("error", (err) => {
        console.error(`[gateway] ws error from ${remote}:`, err);
    });
}
