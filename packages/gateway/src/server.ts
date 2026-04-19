import { createServer as createHttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { handleConnection } from "./connection.js";
import { createHttpHandler } from "./httpHandler.js";
import type { Router } from "./router.js";
import type { KeepAliveManager } from "./keepAlive.js";
import type { CronScheduler } from "./crons.js";

export interface ServerDeps {
    router: Router | null;
    keepAlive: KeepAliveManager;
    crons: CronScheduler;
}

export function startServer(deps: ServerDeps): { wss: WebSocketServer; close: () => void } {
    const httpHandler = createHttpHandler({ keepAlive: deps.keepAlive, crons: deps.crons });
    const httpServer = createHttpServer(httpHandler);
    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws: WebSocket, req) => {
        const remote = req.socket.remoteAddress ?? "unknown";
        console.log(`[gateway] client connected from ${remote}`);
        handleConnection(ws, remote, deps.router, deps.keepAlive, deps.crons);
    });

    httpServer.listen(config.gateway.port, config.gateway.host, () => {
        console.log(`[gateway] listening on http://${config.gateway.host}:${config.gateway.port} (ws + http)`);
    });

    return {
        wss,
        close: () => {
            wss.close();
            httpServer.close();
        },
    };
}
