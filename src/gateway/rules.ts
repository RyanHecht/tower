import type { PermissionRequest } from "@github/copilot-sdk";

/**
 * Per-session allow/deny rule grammar — a pragmatic subset of the
 * `copilot --allow-tool` / `--deny-tool` syntax (`kind(arg)`).
 *
 * Supported kinds: shell, write, read, url, mcp, custom-tool.
 * - Bare kind (e.g. `shell`) matches every request of that kind.
 * - `kind(arg)` matches the request's primary identifier per kind:
 *     shell(git push)        exact match against fullCommandText / any command identifier
 *     shell(git:*)           prefix match on the first command stem
 *     write(src/*.ts)        glob match against fileName
 *     read(/etc/*)           glob match against fileName
 *     url(github.com)        host substring (protocol-stripped) match against url
 *     url(https://gh.com/*)  full-URL glob match (protocol-aware)
 *     mcp(server)            all tools from an MCP server (matches serverName)
 *     mcp(server:tool)       exact server + tool match
 *     custom-tool(name)      exact toolName match (supports * glob)
 *
 * Special: `*` or `all` matches every request of every kind.
 *
 * Precedence at evaluation time: deny rules win over allow rules.
 */

export type RuleKind = "shell" | "write" | "read" | "url" | "mcp" | "custom-tool" | "any";

export interface ParsedRule {
    raw: string;
    kind: RuleKind;
    /** Argument inside the parentheses, or null for bare kind / `*`. */
    arg: string | null;
}

const KIND_ALIASES: Record<string, RuleKind> = {
    shell: "shell",
    write: "write",
    read: "read",
    url: "url",
    mcp: "mcp",
    "custom-tool": "custom-tool",
    custom_tool: "custom-tool",
    "*": "any",
    all: "any",
};

export class RuleParseError extends Error {}

const RULE_RE = /^([a-z][a-z_-]*|\*)(?:\((.*)\))?$/i;

export function parseRule(input: string): ParsedRule {
    const raw = input.trim();
    if (!raw) throw new RuleParseError("empty rule");
    const m = RULE_RE.exec(raw);
    if (!m) throw new RuleParseError(`unrecognised rule: "${raw}"`);
    const head = m[1]!.toLowerCase();
    const kind = KIND_ALIASES[head];
    if (!kind) throw new RuleParseError(`unknown kind "${head}" in rule "${raw}"`);
    const arg = m[2] !== undefined ? m[2].trim() : null;
    if (kind === "any" && arg !== null) throw new RuleParseError(`"${head}" does not take an argument`);
    return { raw, kind, arg: arg && arg.length > 0 ? arg : null };
}

export function parseRules(inputs: readonly string[] | undefined): ParsedRule[] {
    if (!inputs) return [];
    return inputs.map(parseRule);
}

// ── Matching helpers ────────────────────────────────────────────────

/** Convert a glob pattern (`*`, `?`) to a RegExp anchored to the whole string. */
function globToRegex(glob: string): RegExp {
    let re = "^";
    for (const ch of glob) {
        if (ch === "*") re += ".*";
        else if (ch === "?") re += ".";
        else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(re + "$");
}

function asString(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function firstStem(cmd: string): string {
    const trimmed = cmd.trim();
    const sp = trimmed.search(/\s/);
    return sp < 0 ? trimmed : trimmed.slice(0, sp);
}

function matchShell(arg: string, req: PermissionRequest): boolean {
    const full = asString(req.fullCommandText) ?? "";
    const commands = Array.isArray(req.commands) ? (req.commands as Array<Record<string, unknown>>) : [];
    const ids = commands.map((c) => asString(c.identifier) ?? "").filter(Boolean);
    const candidates = [full, ...ids];

    // Prefix form: "git:*" matches any command whose first token is "git"
    if (arg.endsWith(":*")) {
        const prefix = arg.slice(0, -2);
        return candidates.some((c) => firstStem(c) === prefix);
    }
    // Exact match against full command text or any registered command identifier
    return candidates.some((c) => c === arg || firstStem(c) === arg);
}

function matchPath(arg: string, req: PermissionRequest): boolean {
    const fileName = asString(req.fileName);
    if (!fileName) return false;
    return globToRegex(arg).test(fileName);
}

function matchUrl(arg: string, req: PermissionRequest): boolean {
    const url = asString(req.url);
    if (!url) return false;
    if (arg.includes("://") || arg.includes("*")) {
        // Protocol-aware glob match
        return globToRegex(arg).test(url);
    }
    // Bare host substring: "github.com" matches "https://api.github.com/..."
    try {
        const u = new URL(url);
        return u.hostname === arg || u.hostname.endsWith("." + arg);
    } catch {
        return url.includes(arg);
    }
}

function matchMcp(arg: string, req: PermissionRequest): boolean {
    const server = asString(req.serverName);
    const tool = asString(req.toolName);
    if (!server) return false;
    const [argServer, argTool] = arg.includes(":") ? arg.split(":", 2) as [string, string] : [arg, undefined];
    if (argServer !== server) return false;
    if (argTool === undefined) return true;
    return tool !== undefined && globToRegex(argTool).test(tool);
}

function matchCustomTool(arg: string, req: PermissionRequest): boolean {
    const name = asString(req.toolName);
    if (!name) return false;
    return globToRegex(arg).test(name);
}

export function ruleMatches(rule: ParsedRule, req: PermissionRequest): boolean {
    if (rule.kind === "any") return true;
    if (rule.kind !== req.kind) return false;
    if (rule.arg === null) return true;
    switch (rule.kind) {
        case "shell": return matchShell(rule.arg, req);
        case "write":
        case "read":  return matchPath(rule.arg, req);
        case "url":   return matchUrl(rule.arg, req);
        case "mcp":   return matchMcp(rule.arg, req);
        case "custom-tool": return matchCustomTool(rule.arg, req);
        default:      return false;
    }
}

export type RuleDecision = "deny" | "allow" | "fall-through";

/** Evaluate deny then allow lists. Deny wins over allow. */
export function evaluateRules(
    req: PermissionRequest,
    deny: readonly ParsedRule[],
    allow: readonly ParsedRule[],
): RuleDecision {
    if (deny.some((r) => ruleMatches(r, req))) return "deny";
    if (allow.some((r) => ruleMatches(r, req))) return "allow";
    return "fall-through";
}
