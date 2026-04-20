import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { startServer } from "./server.js";
import { getCopilotClient, shutdownCopilotClient } from "./copilot.js";
import { Router } from "./router.js";
import { resolveWorkspace } from "./workspaces.js";
import { KeepAliveManager } from "./keepAlive.js";
import { CronScheduler } from "./crons.js";
import { destroyAllDisplays } from "./displayManager.js";
import { loadUserSessionConfig } from "./sessionConfig.js";
import { StateStore } from "./state.js";

async function ensureDirs(): Promise<void> {
    await Promise.all(
        [config.paths.data, config.paths.logs, config.paths.workspaces].map((p) =>
            fs.mkdir(p, { recursive: true }),
        ),
    );
}

async function bootRouter(store: StateStore): Promise<Router | null> {
    try {
        const client = await getCopilotClient();
        const router = new Router(client, {
            listSessions: () => client.listSessions(),
            createSession: async (workspace, _reason) => {
                const cwd = await resolveWorkspace(workspace);
                // Bare session with a deny-all permission handler. The router
                // disconnects immediately; the next client to `session.resume`
                // installs its own policy.
                const session = await client.createSession({
                    workingDirectory: cwd,
                    onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
                });
                const sessionId = session.sessionId;
                try { await session.disconnect(); } catch { /* ignore */ }
                return sessionId;
            },
        });
        await router.init({
            resumeSessionId: store.getRouterSessionId(),
            onSessionId: (sid) => store.setRouterSessionId(sid),
        });
        return router;
    } catch (err) {
        console.error("[gateway] router failed to start (continuing without it):", err);
        return null;
    }
}

async function main(): Promise<void> {
    await ensureDirs();
    console.log(`[gateway] root=${config.root}`);
    console.log(`[gateway] daemon cliUrl=${config.daemon.host}:${config.daemon.port}`);

    const store = new StateStore();
    await store.load();
    await loadUserSessionConfig();

    const client = await getCopilotClient();
    const keepAlive = new KeepAliveManager(client, store);
    await keepAlive.hydrate();

    const router = await bootRouter(store);
    const crons = new CronScheduler(store, keepAlive);
    crons.hydrate();
    const { close } = startServer({ router, keepAlive, crons, store });

    const shutdown = async (signal: string) => {
        console.log(`[gateway] received ${signal}, shutting down`);
        close();
        crons.stop();
        keepAlive.stop();
        await destroyAllDisplays();
        if (router) await router.shutdown();
        await store.flush();
        await shutdownCopilotClient();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
    console.error("[gateway] fatal:", err);
    process.exit(1);
});
