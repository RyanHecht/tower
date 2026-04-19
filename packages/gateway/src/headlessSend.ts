import type { PermissionRequestResult } from "@github/copilot-sdk";
import { getCopilotClient } from "./copilot.js";
import { getSession, noteSend } from "./sessionAttachments.js";
import type { KeepAliveManager } from "./keepAlive.js";

/**
 * Send a prompt to a session without any interactive subscriber.
 *
 * If the session already has an SDK handle in the registry (because a TUI
 * or previous headless send attached it), we reuse that handle directly.
 *
 * If not, we create an **ephemeral** SDK handle: resume → send → disconnect.
 * This avoids "poisoning" the registry's permission policy — the next
 * interactive subscriber will register its own policy from scratch.
 *
 * Permission requests during a headless send are auto-denied (no surface
 * to prompt). The caller should expect that some tools may fail.
 */
export async function headlessSend(
    sessionId: string,
    prompt: string,
    keepAlive: KeepAliveManager,
): Promise<void> {
    keepAlive.touch(sessionId);

    // Fast path: session is already attached in the registry.
    const existing = getSession(sessionId);
    if (existing) {
        noteSend(sessionId);
        await existing.send({ prompt });
        return;
    }

    // Slow path: ephemeral resume → send → disconnect.
    const client = await getCopilotClient();
    const autoDeny = (): PermissionRequestResult => ({
        kind: "denied-by-rules",
        rules: [],
    });
    const session = await client.resumeSession(sessionId, {
        onPermissionRequest: async () => autoDeny(),
    });
    try {
        await session.send({ prompt });
    } finally {
        try { await session.disconnect(); } catch { /* ignore */ }
    }
}
