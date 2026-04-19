import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { handleConnection } from "./connection.js";
import type { Router } from "./router.js";
import type { KeepAliveManager } from "./keepAlive.js";

export function startServer(router: Router | null, keepAlive: KeepAliveManager): WebSocketServer {
    const wss = new WebSocketServer({ host: config.gateway.host, port: config.gateway.port });

    wss.on("listening", () => {
        const addr = wss.address();
        const where = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
        console.log(`[gateway] listening on ws://${where}`);
    });

    wss.on("connection", (ws: WebSocket, req) => {
        const remote = req.socket.remoteAddress ?? "unknown";
        console.log(`[gateway] client connected from ${remote}`);
        handleConnection(ws, remote, router, keepAlive);
    });

    return wss;
}
