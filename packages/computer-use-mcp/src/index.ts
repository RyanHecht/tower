/**
 * Computer Use MCP Server
 *
 * Provides generic desktop interaction tools (xdotool + scrot) over the
 * Model Context Protocol (MCP) stdio transport. Designed to run on a
 * per-session Xvfb virtual display managed by the Tower gateway.
 *
 * Usage: DISPLAY=:10 node dist/index.js
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ── MCP Protocol Types ─────────────────────────────────────────────────

interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number;
    result?: unknown;
    error?: { code: number; message: string };
}

interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

interface ToolResult {
    content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
    >;
    isError?: boolean;
}

// ── Tool Definitions ───────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
    {
        name: "screenshot",
        description:
            "Take a screenshot of the virtual display. Returns a PNG image. " +
            "Use this to see what's currently on screen before interacting.",
        inputSchema: {
            type: "object",
            properties: {
                activeWindow: {
                    type: "boolean",
                    description: "If true, capture only the focused window. Default: false (full screen).",
                },
            },
        },
    },
    {
        name: "mouse_click",
        description: "Click at specific coordinates on the display.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate." },
                y: { type: "number", description: "Y coordinate." },
                button: { type: "number", description: "Mouse button: 1=left, 2=middle, 3=right. Default: 1." },
                doubleClick: { type: "boolean", description: "Double-click instead of single click. Default: false." },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "mouse_move",
        description: "Move the mouse cursor to specific coordinates without clicking.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate." },
                y: { type: "number", description: "Y coordinate." },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "mouse_drag",
        description: "Click-and-drag from one point to another.",
        inputSchema: {
            type: "object",
            properties: {
                startX: { type: "number", description: "Starting X coordinate." },
                startY: { type: "number", description: "Starting Y coordinate." },
                endX: { type: "number", description: "Ending X coordinate." },
                endY: { type: "number", description: "Ending Y coordinate." },
                button: { type: "number", description: "Mouse button. Default: 1 (left)." },
            },
            required: ["startX", "startY", "endX", "endY"],
        },
    },
    {
        name: "type_text",
        description:
            "Type text at the current cursor position. Handles most printable " +
            "characters. For special keys or combinations, use press_key instead.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "The text to type." },
                delay: { type: "number", description: "Delay between keystrokes in milliseconds. Default: 0." },
            },
            required: ["text"],
        },
    },
    {
        name: "press_key",
        description:
            "Press a key or key combination. Uses xdotool key names: " +
            "Return, Tab, Escape, BackSpace, Delete, space, Home, End, " +
            "Page_Up, Page_Down, Up, Down, Left, Right, F1–F12. " +
            "Modifiers: ctrl, alt, shift, super. " +
            "Combine with '+': 'ctrl+c', 'ctrl+shift+t', 'alt+F4'.",
        inputSchema: {
            type: "object",
            properties: {
                keys: {
                    type: "string",
                    description: "Key or combination (e.g., 'Return', 'ctrl+c', 'alt+Tab').",
                },
            },
            required: ["keys"],
        },
    },
    {
        name: "scroll",
        description: "Scroll the mouse wheel at a position on the display.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate to scroll at." },
                y: { type: "number", description: "Y coordinate to scroll at." },
                direction: {
                    type: "string",
                    enum: ["up", "down", "left", "right"],
                    description: "Scroll direction.",
                },
                clicks: { type: "number", description: "Number of scroll increments. Default: 3." },
            },
            required: ["x", "y", "direction"],
        },
    },
    {
        name: "get_cursor_position",
        description: "Get the current mouse cursor position.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_screen_size",
        description: "Get the virtual display dimensions in pixels.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "list_windows",
        description:
            "List all visible windows with their IDs, titles, positions, and sizes. " +
            "Use the window ID with focus_window to bring a window to the front.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "focus_window",
        description: "Bring a window to focus by its X11 window ID (from list_windows).",
        inputSchema: {
            type: "object",
            properties: {
                windowId: { type: "number", description: "X11 window ID." },
            },
            required: ["windowId"],
        },
    },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function tmpPath(): string {
    return join(tmpdir(), `cu-${randomBytes(4).toString("hex")}.png`);
}

function xdotool(...args: string[]): string {
    return execFileSync("xdotool", args, { encoding: "utf8", timeout: 10_000 }).trim();
}

function text(t: string): ToolResult {
    return { content: [{ type: "text", text: t }] };
}

function errorResult(msg: string): ToolResult {
    return { content: [{ type: "text", text: msg }], isError: true };
}

// ── Tool Implementations ───────────────────────────────────────────────

function takeScreenshot(args: Record<string, unknown>): ToolResult {
    const file = tmpPath();
    try {
        const scrotArgs = args.activeWindow ? ["-u", file] : [file];
        execFileSync("scrot", scrotArgs, { timeout: 10_000 });
        const data = readFileSync(file).toString("base64");
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
    } catch (err) {
        return errorResult(`Screenshot failed: ${(err as Error).message}`);
    } finally {
        try { unlinkSync(file); } catch { /* ignore */ }
    }
}

function mouseClick(args: Record<string, unknown>): ToolResult {
    const x = args.x as number;
    const y = args.y as number;
    const button = (args.button as number | undefined) ?? 1;
    const cmdArgs: string[] = ["mousemove", "--", String(x), String(y)];
    if (args.doubleClick) {
        cmdArgs.push("click", "--repeat", "2", "--delay", "100", String(button));
    } else {
        cmdArgs.push("click", String(button));
    }
    xdotool(...cmdArgs);
    return text(`Clicked at (${x}, ${y}) button=${button}${args.doubleClick ? " (double)" : ""}`);
}

function mouseMove(args: Record<string, unknown>): ToolResult {
    xdotool("mousemove", "--", String(args.x), String(args.y));
    return text(`Moved cursor to (${args.x}, ${args.y})`);
}

function mouseDrag(args: Record<string, unknown>): ToolResult {
    const { startX, startY, endX, endY } = args as {
        startX: number; startY: number; endX: number; endY: number;
    };
    const button = (args.button as number | undefined) ?? 1;
    xdotool(
        "mousemove", "--", String(startX), String(startY),
        "mousedown", String(button),
        "mousemove", "--", String(endX), String(endY),
        "mouseup", String(button),
    );
    return text(`Dragged from (${startX},${startY}) to (${endX},${endY})`);
}

function typeText(args: Record<string, unknown>): ToolResult {
    const input = args.text as string;
    const delay = (args.delay as number | undefined) ?? 0;
    const xArgs: string[] = ["type"];
    if (delay > 0) xArgs.push("--delay", String(delay));
    xArgs.push("--", input);
    xdotool(...xArgs);
    return text(`Typed ${input.length} character(s)`);
}

function pressKey(args: Record<string, unknown>): ToolResult {
    const keys = args.keys as string;
    xdotool("key", "--", keys);
    return text(`Pressed: ${keys}`);
}

function scroll(args: Record<string, unknown>): ToolResult {
    const x = args.x as number;
    const y = args.y as number;
    const direction = args.direction as string;
    const clicks = (args.clicks as number | undefined) ?? 3;
    // Move to position first
    xdotool("mousemove", "--", String(x), String(y));
    // xdotool button mapping: 4=up, 5=down, 6=left, 7=right
    const buttonMap: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };
    const button = buttonMap[direction] ?? 5;
    xdotool("click", "--repeat", String(clicks), String(button));
    return text(`Scrolled ${direction} ${clicks} click(s) at (${x}, ${y})`);
}

function getCursorPosition(): ToolResult {
    const output = xdotool("getmouselocation");
    const match = output.match(/x:(\d+)\s+y:(\d+)/);
    if (match) {
        return text(JSON.stringify({ x: parseInt(match[1]!, 10), y: parseInt(match[2]!, 10) }));
    }
    return text(output);
}

function getScreenSize(): ToolResult {
    const output = xdotool("getdisplaygeometry");
    const parts = output.split(/\s+/);
    return text(JSON.stringify({ width: parseInt(parts[0]!, 10), height: parseInt(parts[1]!, 10) }));
}

function listWindows(): ToolResult {
    try {
        const ids = xdotool("search", "--onlyvisible", "--name", "").split("\n").filter(Boolean);
        const windows = ids.map((id) => {
            try {
                const name = xdotool("getwindowname", id);
                const geo = xdotool("getwindowgeometry", "--shell", id);
                const props: Record<string, string> = {};
                for (const line of geo.split("\n")) {
                    const eq = line.indexOf("=");
                    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                }
                return {
                    windowId: parseInt(id, 10),
                    name,
                    x: parseInt(props["X"] ?? "0", 10),
                    y: parseInt(props["Y"] ?? "0", 10),
                    width: parseInt(props["WIDTH"] ?? "0", 10),
                    height: parseInt(props["HEIGHT"] ?? "0", 10),
                };
            } catch {
                return { windowId: parseInt(id, 10), name: "(unknown)", x: 0, y: 0, width: 0, height: 0 };
            }
        });
        return text(JSON.stringify(windows, null, 2));
    } catch {
        return text("[]");
    }
}

function focusWindow(args: Record<string, unknown>): ToolResult {
    const windowId = args.windowId as number;
    xdotool("windowactivate", "--sync", String(windowId));
    return text(`Focused window ${windowId}`);
}

// ── Tool Dispatch ──────────────────────────────────────────────────────

function executeTool(name: string, args: Record<string, unknown>): ToolResult {
    switch (name) {
        case "screenshot":          return takeScreenshot(args);
        case "mouse_click":         return mouseClick(args);
        case "mouse_move":          return mouseMove(args);
        case "mouse_drag":          return mouseDrag(args);
        case "type_text":           return typeText(args);
        case "press_key":           return pressKey(args);
        case "scroll":              return scroll(args);
        case "get_cursor_position": return getCursorPosition();
        case "get_screen_size":     return getScreenSize();
        case "list_windows":        return listWindows();
        case "focus_window":        return focusWindow(args);
        default:                    return errorResult(`Unknown tool: ${name}`);
    }
}

// ── MCP Stdio Transport ────────────────────────────────────────────────

function sendMessage(msg: JsonRpcResponse): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    process.stdout.write(header + json);
}

function handleMessage(msg: JsonRpcMessage): void {
    // Notifications (no id) don't get responses.
    if (msg.id === undefined) return;

    switch (msg.method) {
        case "initialize":
            sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "computer-use", version: "0.1.0" },
                },
            });
            break;

        case "tools/list":
            sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: { tools: TOOLS },
            });
            break;

        case "tools/call": {
            const params = msg.params as { name: string; arguments?: Record<string, unknown> } | undefined;
            if (!params?.name) {
                sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: { code: -32602, message: "Missing tool name" },
                });
                break;
            }
            try {
                const result = executeTool(params.name, params.arguments ?? {});
                sendMessage({ jsonrpc: "2.0", id: msg.id, result });
            } catch (err) {
                sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: errorResult(`Error: ${(err as Error).message}`),
                });
            }
            break;
        }

        case "ping":
            sendMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
            break;

        default:
            sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` },
            });
    }
}

// Parse Content-Length framed messages from stdin.
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = buffer.subarray(0, headerEnd).toString();
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            buffer = buffer.subarray(headerEnd + 4);
            continue;
        }

        const length = parseInt(match[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;

        const body = buffer.subarray(bodyStart, bodyStart + length).toString();
        buffer = buffer.subarray(bodyStart + length);

        try {
            handleMessage(JSON.parse(body) as JsonRpcMessage);
        } catch {
            // Ignore malformed JSON
        }
    }
});

process.stdin.on("end", () => process.exit(0));
process.stderr.write("[computer-use-mcp] server started\n");
