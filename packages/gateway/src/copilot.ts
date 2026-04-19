import { CopilotClient } from "@github/copilot-sdk";
import { cliUrl } from "./config.js";

let clientPromise: Promise<CopilotClient> | null = null;

/** A single shared CopilotClient instance, attached to the local daemon over JSON-RPC.
 *  Lazy-initialized; safe to call from many concurrent connections. */
export function getCopilotClient(): Promise<CopilotClient> {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
        const client = new CopilotClient({ cliUrl });
        await client.start();
        return client;
    })().catch((err) => {
        clientPromise = null; // allow retry on next call
        throw err;
    });
    return clientPromise;
}

export async function shutdownCopilotClient(): Promise<void> {
    if (!clientPromise) return;
    try {
        const client = await clientPromise;
        await client.stop();
    } catch {
        /* ignore */
    } finally {
        clientPromise = null;
    }
}
