import type { WebSocket } from "ws";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { Inbound, PermissionMode } from "@tower/protocol";
import { DEFAULT_PERMISSION_MODE, isPermissionMode } from "@tower/protocol";
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
    noteSend,
    register,
    setDisplayUrl,
    type Subscription,
} from "./sessionAttachments.js";
import { KeepAliveManager, type KeepAlivePolicy } from "./keepAlive.js";
import type { CronScheduler } from "./crons.js";
import type { StateStore } from "./state.js";
import { launchDisplay, getDisplay, destroyDisplay, listDisplays } from "./displayManager.js";
import { buildSessionConfig, ensurePersistedDisplay } from "./sessionConfig.js";
import { flushToShared } from "./sessionTools.js";

interface InboundBase {
    type: string;
    id?: string | number;
}

export function handleConnection(ws: WebSocket, remote: string, router: Router | null, keepAlive: KeepAliveManager, crons: CronScheduler, store: StateStore): void {
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
                const mode: PermissionMode = isPermissionMode(msg.permissionMode) ? msg.permissionMode : DEFAULT_PERMISSION_MODE;
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
                    let handler: ((req: PermissionRequest) => Promise<PermissionRequestResult>) | null = null;
                    const cfg = buildSessionConfig("", store, keepAlive);
                    const session = await client.createSession({
                        ...(msg.model ? { model: msg.model } : {}),
                        workingDirectory: cwd,
                        onPermissionRequest: (req) => handler!(req),
                        tools: cfg.tools,
                        ...(Object.keys(cfg.mcpServers).length > 0 ? { mcpServers: cfg.mcpServers } : {}),
                        ...(cfg.skillDirectories.length > 0 ? { skillDirectories: cfg.skillDirectories } : {}),
                        ...(cfg.disabledSkills.length > 0 ? { disabledSkills: cfg.disabledSkills } : {}),
                        ...(cfg.customAgents.length > 0 ? { customAgents: cfg.customAgents } : {}),
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
                const mode: PermissionMode = isPermissionMode(msg.permissionMode) ? msg.permissionMode : DEFAULT_PERMISSION_MODE;
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
                        session = existing;
                        policy = buildSessionPolicy(msg.sessionId, mode, allow, deny);
                    } else {
                        // Re-launch the display before building config so
                        // builtinMcpServers sees it and includes Playwright.
                        await ensurePersistedDisplay(msg.sessionId, store);
                        const client = await getCopilotClient();
                        let handler: ((req: PermissionRequest) => Promise<PermissionRequestResult>) | null = null;
                        const cfg = buildSessionConfig(msg.sessionId, store, keepAlive);
                        session = await client.resumeSession(msg.sessionId, {
                            onPermissionRequest: (req) => handler!(req),
                            tools: cfg.tools,
                            ...(Object.keys(cfg.mcpServers).length > 0 ? { mcpServers: cfg.mcpServers } : {}),
                            ...(cfg.skillDirectories.length > 0 ? { skillDirectories: cfg.skillDirectories } : {}),
                            ...(cfg.disabledSkills.length > 0 ? { disabledSkills: cfg.disabledSkills } : {}),
                            ...(cfg.customAgents.length > 0 ? { customAgents: cfg.customAgents } : {}),
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
                noteSend(msg.sessionId);
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
                    subs.delete(msg.sessionId);
                    await forceDetach(msg.sessionId);
                    await flushToShared(msg.sessionId);
                    await destroyDisplay(msg.sessionId);
                    store.setDisplay(msg.sessionId, false);
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

            // ── Cron management ────────────────────────────────────────

            case "cron.create": {
                try {
                    const job = crons.create(msg.sessionId, msg.schedule, msg.prompt);
                    respond(msg.id, true, { cron: job });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "cron.list": {
                respond(msg.id, true, { crons: crons.list() });
                return;
            }

            case "cron.get": {
                const job = crons.get(msg.cronId);
                if (!job) return respond(msg.id, false, `cron not found: ${msg.cronId}`);
                respond(msg.id, true, { cron: job });
                return;
            }

            case "cron.update": {
                try {
                    const job = crons.update(msg.cronId, {
                        schedule: msg.schedule,
                        prompt: msg.prompt,
                        enabled: msg.enabled,
                        sessionId: msg.sessionId,
                    });
                    respond(msg.id, true, { cron: job });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "cron.delete": {
                const deleted = crons.delete(msg.cronId);
                if (!deleted) return respond(msg.id, false, `cron not found: ${msg.cronId}`);
                respond(msg.id, true, { deleted: true });
                return;
            }

            // ── Display management ─────────────────────────────────────

            case "display.launch": {
                try {
                    const info = await launchDisplay(msg.sessionId);
                    setDisplayUrl(msg.sessionId, info.noVncUrl);
                    respond(msg.id, true, { display: info });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "display.get": {
                const info = getDisplay(msg.sessionId);
                if (!info) return respond(msg.id, false, "no display for this session");
                respond(msg.id, true, { display: info });
                return;
            }

            case "display.destroy": {
                await destroyDisplay(msg.sessionId);
                setDisplayUrl(msg.sessionId, undefined);
                respond(msg.id, true, { destroyed: true });
                return;
            }

            case "display.list": {
                respond(msg.id, true, { displays: listDisplays() });
                return;
            }

            // ── Tier 1: direct SDK pass-through ────────────────────────

            case "models.list": {
                try {
                    const client = await getCopilotClient();
                    const result = await client.listModels();
                    respond(msg.id, true, { models: result });
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "account.quota": {
                try {
                    const client = await getCopilotClient();
                    const result = await client.rpc.account.getQuota();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.model.get": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.model.getCurrent();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.model.set": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.model.switchTo({ modelId: msg.model });
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.mode.get": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.mode.get();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.mode.set": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.mode.set({ mode: msg.mode });
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.plan.read": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.plan.read();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.plan.update": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.plan.update({ content: msg.content });
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.plan.delete": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.plan.delete();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.compact": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.compaction.compact();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.fleet.start": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.fleet.start({
                        ...(msg.prompt ? { prompt: msg.prompt } : {}),
                    });
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.agent.list": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.agent.list();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.agent.get": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.agent.getCurrent();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.agent.select": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.agent.select({ name: msg.name });
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
                return;
            }

            case "session.agent.deselect": {
                const session = getSession(msg.sessionId);
                if (!session) return respond(msg.id, false, `not attached to session ${msg.sessionId}`);
                try {
                    const result = await session.rpc.agent.deselect();
                    respond(msg.id, true, result);
                } catch (err) {
                    respond(msg.id, false, (err as Error).message);
                }
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
