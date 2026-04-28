import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PROJECT_ROOT ?? path.resolve(here, "..", "..", "..");

export const config = {
    root: ROOT,
    daemon: {
        host: process.env.DAEMON_HOST ?? "127.0.0.1",
        port: Number(process.env.DAEMON_PORT ?? 4321),
    },
    gateway: {
        host: process.env.GATEWAY_HOST ?? "127.0.0.1",
        port: Number(process.env.GATEWAY_PORT ?? 8787),
    },
    paths: {
        data: path.join(ROOT, "data"),
        logs: path.join(ROOT, "logs"),
        workspaces: path.join(ROOT, "workspaces"),
        tokens: path.join(ROOT, "data", "tokens.json"),
        /** Base directory for per-session Chromium profiles. Each session
         *  gets its own subdirectory so profiles don't collide. Lives under
         *  data/ so it's on the bind-mounted volume. */
        chromiumProfiles: path.join(ROOT, "data", "chromium-profiles"),
        /** Shared auth pool. Auth files (cookies, logins, localStorage) are
         *  synced from here on display launch and flushed back on destroy,
         *  so sign-ins accumulate organically across sessions. */
        chromiumShared: path.join(ROOT, "data", "chromium-shared"),
        /** Git-backed knowledge vault. Contains core memory, archival memory,
         *  session summaries, and project working directories. */
        vault: path.join(ROOT, "data", "vault"),
        /** User-added external vaults (read/write). */
        vaults: path.join(ROOT, "data", "vaults"),
    },
} as const;

/** "host:port" form expected by the SDK's cliUrl option. */
export const cliUrl = `${config.daemon.host}:${config.daemon.port}`;
