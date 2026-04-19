/**
 * Shared WebSocket message types between the gateway and any client surface.
 *
 * Wire format: each frame is a single JSON object on its own line. Clients
 * MUST send `{ type: "hello", token }` first; everything after that is
 * authenticated.
 */

import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

/**
 *   yolo   — auto-approve every permission request.
 *   safe   — auto-approve `read` requests; prompt the surface for everything else.
 *   prompt — relay every request to the surface (default).
 */
export type PermissionMode = "yolo" | "safe" | "prompt";

export const PERMISSION_MODES: readonly PermissionMode[] = ["yolo", "safe", "prompt"];

export function isPermissionMode(s: unknown): s is PermissionMode {
    return typeof s === "string" && (PERMISSION_MODES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------------------------

/**
 * Keep-alive policy chosen by the client per session.
 *
 *   default          — rely on the CLI daemon's built-in 30-minute idle reaper.
 *   forever          — gateway pings periodically; only `session.delete` ends it.
 *   { idleMs: N }    — gateway-enforced idle window; activity = `session.send`.
 */
export type KeepAlivePolicy =
    | { kind: "default" }
    | { kind: "forever" }
    | { kind: "idle"; idleMs: number };

// ---------------------------------------------------------------------------
// Inbound (surface → gateway)
// ---------------------------------------------------------------------------

export type Inbound =
    | { type: "hello"; token: string }
    | {
          type: "session.create";
          id: string | number;
          workspace: string;
          model?: string;
          permissionMode?: string;
          allow?: string[];
          deny?: string[];
          keepAlive?: unknown;
      }
    | {
          type: "session.resume";
          id: string | number;
          sessionId: string;
          permissionMode?: string;
          allow?: string[];
          deny?: string[];
          keepAlive?: unknown;
      }
    | { type: "session.list"; id: string | number }
    | { type: "session.listAll"; id: string | number }
    | { type: "session.send"; sessionId: string; prompt: string }
    | { type: "session.abort"; sessionId: string }
    | { type: "session.keepAlive"; id: string | number; sessionId: string; keepAlive: unknown }
    | { type: "session.delete"; id: string | number; sessionId: string }
    | { type: "permission.reply"; requestId: string; decision: "approve" | "deny" }
    | { type: "router.ask"; id: string | number; prompt: string }
    | { type: "router.info"; id: string | number };

export type InboundType = Inbound["type"];

// ---------------------------------------------------------------------------
// Outbound (gateway → surface)
// ---------------------------------------------------------------------------

export interface ReadyMessage {
    type: "ready";
}

export interface ResultMessage<T = unknown> {
    type: "result";
    id?: string | number;
    ok: boolean;
    data?: T;
    error?: string;
}

export interface EventMessage {
    type: "event";
    sessionId: string;
    event: SessionEvent;
}

export interface PermissionRequestMessage {
    type: "permission.request";
    requestId: string;
    sessionId: string;
    request: PermissionRequest;
}

export type Outbound = ReadyMessage | ResultMessage | EventMessage | PermissionRequestMessage;

/**
 * Item shape returned by `session.listAll`. Augments the on-disk metadata with
 * an `isActive` flag (currently attached to the daemon by some connection or
 * is the router's own session) so launchers can partition into active vs
 * archived without needing extra round-trips.
 */
export interface SessionListAllItem {
    sessionId: string;
    workspace?: string;
    summary?: string;
    lastActivityAt?: string;
    isActive: boolean;
}

// ---------------------------------------------------------------------------
// Helpers for client surfaces
// ---------------------------------------------------------------------------

/** Forwarded SessionEvent types — useful when surfaces want to filter. */
export const FORWARDED_EVENT_TYPES = [
    "assistant.turn_start",
    "assistant.turn_end",
    "assistant.intent",
    "assistant.message",
    "assistant.message_delta",
    "assistant.reasoning",
    "assistant.reasoning_delta",
    "assistant.streaming_delta",
    "tool.user_requested",
    "tool.execution_start",
    "tool.execution_progress",
    "tool.execution_partial_result",
    "tool.execution_complete",
    "session.idle",
    "session.error",
    "session.warning",
    "session.info",
    "session.task_complete",
    "session.title_changed",
    "session.usage_info",
] as const;

export type ForwardedEventType = (typeof FORWARDED_EVENT_TYPES)[number];

// Re-export the SDK types that show up in the wire format so consumers don't
// need to depend on @github/copilot-sdk directly.
export type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
