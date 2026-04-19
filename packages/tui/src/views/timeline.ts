import type { SessionEvent } from "@tower/protocol";

export type EntryKind =
    | "user"
    | "intent"
    | "reasoning"
    | "assistant"
    | "tool"
    | "info"
    | "warning"
    | "error";

export interface TimelineEntry {
    id: number;
    kind: EntryKind;
    text: string;
    /** For tool entries: derived from execution lifecycle. */
    status?: "pending" | "running" | "ok" | "fail";
    /** For tool entries: latest progress/partial-output line, shown dimmed. */
    progress?: string;
    /** For tool entries: short summary of the result, shown when complete. */
    result?: string;
    /** Tool name, kept separately so the header line stays formatted. */
    toolName?: string;
    /** When true, entry is still being streamed/updated. */
    streaming?: boolean;
}

export type AgentPhase =
    | { kind: "idle" }
    | { kind: "thinking"; detail?: string }
    | { kind: "reasoning"; bytes: number }
    | { kind: "streaming"; bytes: number }
    | { kind: "tool"; name: string; progress?: string };

export interface AgentStatus {
    phase: AgentPhase;
    /** Last assistant.intent we saw — surfaced even after the turn ends. */
    lastIntent?: string;
    /** Most recent error message, if any. */
    lastError?: string;
    /** Cumulative output tokens reported by the SDK for the current turn. */
    streamBytes: number;
    /** Wall-clock millis when the current non-idle phase began. */
    since: number;
}

export const initialStatus = (): AgentStatus => ({
    phase: { kind: "idle" },
    streamBytes: 0,
    since: Date.now(),
});

interface Maps {
    /** messageId -> entry id */
    messages: Map<string, number>;
    /** reasoningId -> entry id */
    reasonings: Map<string, number>;
    /** toolCallId -> entry id */
    tools: Map<string, number>;
    /** toolCallId -> tool name (for status bar lookups after _complete arrives) */
    toolNames: Map<string, string>;
    /**
     * Number of entries at the start of the current assistant turn. Used to
     * splice late-arriving reasoning entries in front of any assistant /
     * tool entries that already streamed for this turn (the SDK sometimes
     * delivers `assistant.reasoning_delta` after the message has begun
     * streaming, which would otherwise show up out of order).
     */
    turnStart: number | null;
}

export const newMaps = (): Maps => ({
    messages: new Map(),
    reasonings: new Map(),
    tools: new Map(),
    toolNames: new Map(),
    turnStart: null,
});

export interface TimelineApi {
    nextId: () => number;
    push: (entry: Omit<TimelineEntry, "id">) => number;
    /** Insert at a specific index. Returns the new entry's id. */
    insertAt: (index: number, entry: Omit<TimelineEntry, "id">) => number;
    update: (id: number, patch: Partial<Omit<TimelineEntry, "id">>) => void;
    /** Append `piece` to the existing text of the entry. */
    append: (id: number, piece: string) => void;
    setStatus: (s: AgentStatus | ((prev: AgentStatus) => AgentStatus)) => void;
    /** Current entry count — used for ordering decisions in the reducer. */
    entryCount: () => number;
    maps: Maps;
}

const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const summariseArgs = (args: unknown): string => {
    if (!args || typeof args !== "object") return "";
    try {
        const json = JSON.stringify(args);
        return truncate(json, 80);
    } catch {
        return "";
    }
};

const summariseResult = (result: unknown): string | undefined => {
    if (result == null) return undefined;
    if (typeof result === "string") return truncate(result.replace(/\s+/g, " "), 120);
    if (typeof result === "object") {
        const r = result as { content?: unknown; detailedContent?: unknown };
        const text = typeof r.content === "string" ? r.content : undefined;
        if (text) return truncate(text.replace(/\s+/g, " "), 120);
    }
    return undefined;
};

/**
 * Apply a single SessionEvent to the timeline + status. Pure-ish: all side
 * effects go through the TimelineApi (which the React component wraps around
 * its useState setters).
 */
export const applyEvent = (api: TimelineApi, event: SessionEvent): void => {
    const ev = event as { type: string; data?: Record<string, unknown> };
    const data = ev.data ?? {};
    const { maps } = api;

    switch (ev.type) {
        case "assistant.turn_start": {
            maps.turnStart = api.entryCount();
            api.setStatus((prev) => ({
                ...prev,
                phase: { kind: "thinking", detail: prev.lastIntent },
                streamBytes: 0,
                since: Date.now(),
            }));
            return;
        }

        case "assistant.intent": {
            const intent = String(data["intent"] ?? "");
            if (!intent) return;
            // Intent is shown in the status bar's detail line, not as a
            // standalone timeline entry — it would just duplicate what the
            // spinner already says.
            api.setStatus((prev) => ({
                ...prev,
                lastIntent: intent,
                phase:
                    prev.phase.kind === "idle"
                        ? { kind: "thinking", detail: intent }
                        : prev.phase.kind === "thinking"
                          ? { kind: "thinking", detail: intent }
                          : prev.phase,
            }));
            return;
        }

        case "assistant.reasoning_delta": {
            const reasoningId = String(data["reasoningId"] ?? "");
            const piece = String(data["deltaContent"] ?? "");
            if (!reasoningId || !piece) return;
            const existing = maps.reasonings.get(reasoningId);
            if (existing == null) {
                // Splice at the turn-start cutoff so reasoning shows above any
                // assistant/tool entries that may have streamed first.
                const at = maps.turnStart ?? api.entryCount();
                const id = api.insertAt(at, { kind: "reasoning", text: piece, streaming: true });
                maps.reasonings.set(reasoningId, id);
                if (maps.turnStart != null) maps.turnStart = at + 1;
            } else {
                api.append(existing, piece);
            }
            api.setStatus((prev) => ({
                ...prev,
                phase: { kind: "reasoning", bytes: prev.streamBytes },
                since: prev.phase.kind === "reasoning" ? prev.since : Date.now(),
            }));
            return;
        }

        case "assistant.reasoning": {
            const reasoningId = String(data["reasoningId"] ?? "");
            const content = String(data["content"] ?? "");
            if (!reasoningId) return;
            const existing = maps.reasonings.get(reasoningId);
            if (existing == null) {
                const at = maps.turnStart ?? api.entryCount();
                const id = api.insertAt(at, { kind: "reasoning", text: content, streaming: false });
                maps.reasonings.set(reasoningId, id);
                if (maps.turnStart != null) maps.turnStart = at + 1;
            } else {
                api.update(existing, { text: content, streaming: false });
            }
            return;
        }

        case "assistant.streaming_delta": {
            const bytes = Number(data["totalResponseSizeBytes"] ?? 0);
            api.setStatus((prev) => ({
                ...prev,
                streamBytes: bytes,
                phase:
                    prev.phase.kind === "tool"
                        ? prev.phase
                        : { kind: "streaming", bytes },
                since: prev.phase.kind === "streaming" ? prev.since : Date.now(),
            }));
            return;
        }

        case "assistant.message_delta": {
            const messageId = String(data["messageId"] ?? "");
            const piece = String(data["deltaContent"] ?? "");
            if (!messageId || !piece) return;
            const existing = maps.messages.get(messageId);
            if (existing == null) {
                const id = api.push({ kind: "assistant", text: piece, streaming: true });
                maps.messages.set(messageId, id);
            } else {
                api.append(existing, piece);
            }
            return;
        }

        case "assistant.message": {
            const messageId = String(data["messageId"] ?? "");
            const content = String(data["content"] ?? "");
            const existing = messageId ? maps.messages.get(messageId) : undefined;
            if (existing != null) {
                // Replace streamed text with the canonical final content.
                api.update(existing, { text: content, streaming: false });
            } else if (content) {
                const id = api.push({ kind: "assistant", text: content, streaming: false });
                if (messageId) maps.messages.set(messageId, id);
            }
            // Surface tool requests embedded in the message as pending tool entries
            // so the user can see "the model wants to call X" before execution starts.
            const toolRequests = (data["toolRequests"] as Array<{
                toolCallId: string;
                name: string;
                arguments?: Record<string, unknown>;
            }> | undefined) ?? [];
            for (const req of toolRequests) {
                if (maps.tools.has(req.toolCallId)) continue;
                const header = `${req.name}(${summariseArgs(req.arguments)})`;
                const id = api.push({
                    kind: "tool",
                    text: header,
                    toolName: req.name,
                    status: "pending",
                });
                maps.tools.set(req.toolCallId, id);
                maps.toolNames.set(req.toolCallId, req.name);
            }
            return;
        }

        case "assistant.turn_end": {
            // Don't go straight to idle — session.idle is the authoritative
            // signal. But clear streaming-specific phases so the spinner stops
            // claiming we're mid-stream.
            api.setStatus((prev) =>
                prev.phase.kind === "streaming" || prev.phase.kind === "reasoning"
                    ? { ...prev, phase: { kind: "thinking", detail: prev.lastIntent } }
                    : prev,
            );
            return;
        }

        case "tool.user_requested":
        case "tool.execution_start": {
            const toolCallId = String(data["toolCallId"] ?? "");
            const toolName = String(data["toolName"] ?? "tool");
            const args = summariseArgs(data["arguments"]);
            const header = `${toolName}(${args})`;
            const existing = maps.tools.get(toolCallId);
            if (existing != null) {
                api.update(existing, { text: header, toolName, status: "running" });
            } else {
                const id = api.push({
                    kind: "tool",
                    text: header,
                    toolName,
                    status: "running",
                });
                maps.tools.set(toolCallId, id);
            }
            maps.toolNames.set(toolCallId, toolName);
            api.setStatus((prev) => ({
                ...prev,
                phase: { kind: "tool", name: toolName },
                since: Date.now(),
            }));
            return;
        }

        case "tool.execution_progress": {
            const toolCallId = String(data["toolCallId"] ?? "");
            const msg = String(data["progressMessage"] ?? "");
            const existing = maps.tools.get(toolCallId);
            if (existing != null && msg) api.update(existing, { progress: msg });
            api.setStatus((prev) =>
                prev.phase.kind === "tool"
                    ? { ...prev, phase: { ...prev.phase, progress: msg } }
                    : prev,
            );
            return;
        }

        case "tool.execution_partial_result": {
            const toolCallId = String(data["toolCallId"] ?? "");
            const piece = String(data["partialOutput"] ?? "");
            const existing = maps.tools.get(toolCallId);
            if (existing != null && piece) {
                // Show only the last line so the entry doesn't grow unbounded.
                const lastLine = piece.split(/\r?\n/).filter(Boolean).pop();
                if (lastLine) api.update(existing, { progress: truncate(lastLine, 120) });
            }
            return;
        }

        case "tool.execution_complete": {
            const toolCallId = String(data["toolCallId"] ?? "");
            const success = data["success"] !== false && !data["error"];
            const result = summariseResult(data["result"]);
            const existing = maps.tools.get(toolCallId);
            if (existing != null) {
                api.update(existing, {
                    status: success ? "ok" : "fail",
                    progress: undefined,
                    result,
                });
            }
            // Drop the per-tool phase. Whatever the agent does next will set its own.
            api.setStatus((prev) =>
                prev.phase.kind === "tool" && prev.phase.name === (maps.toolNames.get(toolCallId) ?? prev.phase.name)
                    ? { ...prev, phase: { kind: "thinking", detail: prev.lastIntent } }
                    : prev,
            );
            return;
        }

        case "session.task_complete": {
            const summary = String(data["summary"] ?? data["message"] ?? "task complete");
            api.push({ kind: "info", text: `✓ ${summary}` });
            return;
        }

        case "session.title_changed": {
            const title = String(data["title"] ?? "");
            if (title) api.push({ kind: "info", text: `(title) ${title}` });
            return;
        }

        case "session.usage_info": {
            // Quiet by default; one-liner for power users.
            const inputTokens = data["inputTokens"];
            const outputTokens = data["outputTokens"];
            if (inputTokens != null || outputTokens != null) {
                api.push({
                    kind: "info",
                    text: `(usage) in=${inputTokens ?? "?"} out=${outputTokens ?? "?"}`,
                });
            }
            return;
        }

        case "session.idle": {
            api.setStatus((prev) => ({ ...prev, phase: { kind: "idle" }, since: Date.now() }));
            return;
        }

        case "session.error": {
            const msg = String(data["message"] ?? "error");
            api.push({ kind: "error", text: msg });
            api.setStatus((prev) => ({ ...prev, lastError: msg }));
            return;
        }

        case "session.warning": {
            const msg = String(data["message"] ?? "");
            if (msg) api.push({ kind: "warning", text: msg });
            return;
        }

        case "session.info": {
            // Suppress by default; the daemon emits a fair number of these.
            return;
        }

        default:
            return;
    }
};
