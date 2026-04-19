import { randomUUID } from "node:crypto";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import { type PermissionMode } from "@tower/protocol";
import { evaluateRules, type ParsedRule } from "./rules.js";

export { type PermissionMode, PERMISSION_MODES, isPermissionMode } from "@tower/protocol";

/** Tools considered low-risk in "safe" mode. Everything else is prompted. */
const SAFE_KINDS = new Set<PermissionRequest["kind"]>(["read"]);

/** Bridge between the SDK's onPermissionRequest callback and an async surface
 *  prompt. The gateway holds one of these per session. */
export interface PendingPrompt {
    requestId: string;
    request: PermissionRequest;
    resolve: (decision: "approve" | "deny") => void;
}

export interface PermissionPolicy {
    /** Implementation of `onPermissionRequest` to pass to the SDK. */
    handler: (request: PermissionRequest) => Promise<PermissionRequestResult>;
    /** Resolve a pending prompt (called when the surface answers). */
    answer: (requestId: string, decision: "approve" | "deny") => void;
    /** Cancel + reject all in-flight prompts (e.g., on disconnect). */
    cancelAll: () => void;
}

export interface PolicyHooks {
    /** Called when the policy needs to ask the surface to make a decision. */
    onPrompt: (pending: PendingPrompt) => void;
}

export interface PolicyOptions {
    mode: PermissionMode;
    /** Pre-parsed allow rules (matches → approve unless overridden by deny). */
    allow?: readonly ParsedRule[];
    /** Pre-parsed deny rules (matches → deny, takes precedence over everything). */
    deny?: readonly ParsedRule[];
}

export function buildPolicy(options: PolicyOptions, hooks: PolicyHooks): PermissionPolicy {
    const { mode, allow = [], deny = [] } = options;
    const pending = new Map<string, PendingPrompt>();

    const askSurface = (request: PermissionRequest) =>
        new Promise<"approve" | "deny">((resolve) => {
            const requestId = randomUUID();
            const entry: PendingPrompt = { requestId, request, resolve };
            pending.set(requestId, entry);
            hooks.onPrompt(entry);
        });

    const handler = async (request: PermissionRequest): Promise<PermissionRequestResult> => {
        // 1. Explicit rules: deny wins over allow.
        const ruled = evaluateRules(request, deny, allow);
        if (ruled === "deny") return { kind: "denied-by-rules", rules: [] };
        if (ruled === "allow") return { kind: "approved" };

        // 2. Mode-based fallback for everything not covered by rules.
        if (mode === "yolo") return { kind: "approved" };
        if (mode === "safe" && SAFE_KINDS.has(request.kind)) return { kind: "approved" };

        // 3. Ask the surface.
        const decision = await askSurface(request);
        return decision === "approve"
            ? { kind: "approved" }
            : { kind: "denied-interactively-by-user" };
    };

    const answer = (requestId: string, decision: "approve" | "deny") => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        entry.resolve(decision);
    };

    const cancelAll = () => {
        for (const entry of pending.values()) entry.resolve("deny");
        pending.clear();
    };

    return { handler, answer, cancelAll };
}
