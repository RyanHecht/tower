import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class WorkspaceError extends Error {}

/** Resolve a client-supplied workspace name to an absolute path under workspaces/.
 *  Creates the dir if missing. Refuses anything that escapes the workspaces root. */
export async function resolveWorkspace(name: string): Promise<string> {
    if (!NAME_PATTERN.test(name)) {
        throw new WorkspaceError(
            `invalid workspace name "${name}" (allowed: letters, digits, dot, dash, underscore; 1–64 chars)`,
        );
    }
    const root = path.resolve(config.paths.workspaces);
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep) && target !== root) {
        throw new WorkspaceError(`workspace path escapes workspaces root: ${target}`);
    }
    await fs.mkdir(target, { recursive: true });
    return target;
}

export async function listWorkspaces(): Promise<string[]> {
    try {
        const entries = await fs.readdir(config.paths.workspaces, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw err;
    }
}
