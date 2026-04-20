import type { Tool } from "@github/copilot-sdk";
import { launchDisplay, getDisplay, destroyDisplay } from "./displayManager.js";
import { setDisplayUrl } from "./sessionAttachments.js";
import type { StateStore } from "./state.js";

/**
 * Custom tools registered on every Tower session.
 *
 * These run inside the gateway process (not the daemon) and can access
 * gateway-managed resources like the display manager.
 */

export function buildSessionTools(store: StateStore): Tool[] {
    return [
        {
            name: "launch_display",
            description:
                "Launch a virtual desktop (Xvfb + window manager + VNC) for this session. " +
                "This MUST be called before using any Playwright browser tools. " +
                "Returns the display identifier and a noVNC URL the user can open " +
                "to watch the desktop. The Playwright MCP server will be available " +
                "on the next turn after this tool returns. Idempotent — safe to call " +
                "if a display is already running.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                const { sessionId } = invocation;
                try {
                    const info = await launchDisplay(sessionId);
                    setDisplayUrl(sessionId, info.noVncUrl);
                    store.setDisplay(sessionId, true);
                    return {
                        status: "ok",
                        display: info.display,
                        noVncUrl: info.noVncUrl,
                        message:
                            `Virtual display ${info.display} is running. ` +
                            `The user can view it at: http://localhost:8787${info.noVncUrl}\n\n` +
                            `Next: launch Chromium on this display using bash:\n` +
                            `  DISPLAY=${info.display} nohup chromium --no-sandbox ` +
                            `--disable-dev-shm-usage --disable-gpu ` +
                            `--remote-debugging-port=9222 "https://example.com" ` +
                            `> /tmp/chromium.log 2>&1 & disown $!\n\n` +
                            `Then take screenshots with: DISPLAY=${info.display} scrot /tmp/screenshot.png`,
                    };
                } catch (err) {
                    return {
                        status: "error",
                        message: `Failed to launch display: ${(err as Error).message}`,
                    };
                }
            },
        },
        {
            name: "get_display",
            description:
                "Check whether this session has a virtual desktop running. " +
                "Returns display info and noVNC URL if active, or a message " +
                "indicating no display is running.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                const info = getDisplay(invocation.sessionId);
                if (!info) {
                    return {
                        status: "no_display",
                        message:
                            "No virtual display is running for this session. " +
                            "Call launch_display first if you need browser tools.",
                    };
                }
                return {
                    status: "ok",
                    display: info.display,
                    noVncUrl: info.noVncUrl,
                };
            },
        },
        {
            name: "destroy_display",
            description:
                "Shut down this session's virtual desktop. Kills the Xvfb, " +
                "window manager, VNC server, and any browser instances running " +
                "on it. Playwright browser tools will no longer work after this.",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async (_args: unknown, invocation) => {
                await destroyDisplay(invocation.sessionId);
                setDisplayUrl(invocation.sessionId, undefined);
                store.setDisplay(invocation.sessionId, false);
                return {
                    status: "ok",
                    message: "Virtual display destroyed.",
                };
            },
        },
    ];
}
