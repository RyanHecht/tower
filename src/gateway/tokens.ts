import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { config } from "./config.js";

interface TokenRecord {
    id: string;
    label: string;
    hash: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

interface TokenStoreFile {
    tokens: TokenRecord[];
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

const equalHex = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    try {
        return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
        return false;
    }
};

async function readStore(): Promise<TokenStoreFile> {
    try {
        const raw = await fs.readFile(config.paths.tokens, "utf8");
        return JSON.parse(raw);
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { tokens: [] };
        throw err;
    }
}

async function writeStore(data: TokenStoreFile): Promise<void> {
    await fs.writeFile(config.paths.tokens, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export interface VerifiedToken {
    id: string;
    label: string;
}

/** Verify a presented bearer token against the on-disk hash store. */
export async function verifyToken(presented: string): Promise<VerifiedToken | null> {
    if (!presented) return null;
    const store = await readStore();
    const presentedHash = sha256Hex(presented);
    for (const t of store.tokens) {
        if (t.revokedAt) continue;
        if (equalHex(t.hash, presentedHash)) {
            t.lastUsedAt = new Date().toISOString();
            // best-effort persist; don't block auth on disk errors
            void writeStore(store).catch(() => {});
            return { id: t.id, label: t.label };
        }
    }
    return null;
}
