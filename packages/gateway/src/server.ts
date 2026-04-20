import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { handleConnection } from "./connection.js";
import { createHttpHandler } from "./httpHandler.js";
import { getVncPort } from "./displayManager.js";
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

    // The main Tower WS protocol — only handles upgrades that are NOT
    // display VNC proxies.
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws: WebSocket, req) => {
        const remote = req.socket.remoteAddress ?? "unknown";
        console.log(`[gateway] client connected from ${remote}`);
        handleConnection(ws, remote, deps.router, deps.keepAlive, deps.crons);
    });

    // Route WebSocket upgrades: VNC proxy vs Tower protocol.
    httpServer.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";

        // /display/:sessionId/websockify → raw TCP bridge to x11vnc
        const vncMatch = url.match(/^\/display\/([^/]+)\/websockify/);
        if (vncMatch?.[1]) {
            const sessionId = vncMatch[1];
            const vncPort = getVncPort(sessionId);
            if (!vncPort) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            // Bridge: upgrade the HTTP connection to raw TCP piped to the
            // VNC port. This is the same thing websockify does — but we
            // let the noVNC client's built-in WebSocket handle the framing.
            // We use a second WSS instance to do the WS↔TCP bridge cleanly.
            const vncWss = new WebSocketServer({ noServer: true });
            vncWss.handleUpgrade(req, socket, head, (ws) => {
                const tcp = netConnect({ host: "127.0.0.1", port: vncPort }, () => {
                    ws.on("message", (data) => {
                        if (tcp.writable) tcp.write(data as Buffer);
                    });
                    tcp.on("data", (data) => {
                        if (ws.readyState === ws.OPEN) ws.send(data);
                    });
                    tcp.on("end", () => ws.close());
                    tcp.on("error", () => ws.close());
                    ws.on("close", () => tcp.destroy());
                    ws.on("error", () => tcp.destroy());
                });
                tcp.on("error", () => {
                    ws.close();
                });
            });
            return;
        }

        // Everything else → Tower WS protocol
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
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
