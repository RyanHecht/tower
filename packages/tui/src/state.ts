import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".config", "tower-tui");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export interface PersistedState {
    /** Last session the user opened — restored on next launch when present. */
    lastSessionId?: string;
    /**
     * Where the user last was when the TUI exited:
     *   - "launcher": come back to the Launcher (default for first run).
     *   - "session":  re-open `lastSessionId` directly if it still exists.
     */
    lastView?: "launcher" | "session";
}

export async function loadState(): Promise<PersistedState> {
    try {
        const raw = await fs.readFile(STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed as PersistedState;
    } catch {
        /* missing or unreadable — return defaults */
    }
    return {};
}

export async function saveState(state: PersistedState): Promise<void> {
    try {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
        /* persistence is best-effort */
    }
}
