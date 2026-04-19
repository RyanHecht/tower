import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { EventMessage, PermissionRequestMessage } from "@tower/protocol";
import type { TowerClient } from "../client.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import {
    applyEvent,
    initialStatus,
    newMaps,
    type AgentStatus,
    type TimelineApi,
    type TimelineEntry,
} from "./timeline.js";

interface Props {
    client: TowerClient;
    sessionId: string;
    initialPrompt?: string;
    onDetach: () => void;
}

interface PendingPermission {
    requestId: string;
    request: PermissionRequestMessage["request"];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const fmtElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${rem.toString().padStart(2, "0")}s`;
};

const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

const colorForKind = (kind: TimelineEntry["kind"]): string => {
    switch (kind) {
        case "user":      return "green";
        case "assistant": return "white";
        case "intent":    return "magenta";
        case "reasoning": return "gray";
        case "tool":      return "cyan";
        case "info":      return "gray";
        case "warning":   return "yellow";
        case "error":     return "red";
    }
};

const prefixForEntry = (entry: TimelineEntry): string => {
    switch (entry.kind) {
        case "user":      return "❯ ";
        case "assistant": return "";
        case "intent":    return "✦ ";
        case "reasoning": return "  ";
        case "tool": {
            const dot =
                entry.status === "ok"      ? "✓"
              : entry.status === "fail"    ? "✗"
              : entry.status === "running" ? "▸"
                                           : "·";
            return `${dot} `;
        }
        case "info":      return "ℹ ";
        case "warning":   return "⚠ ";
        case "error":     return "✗ ";
    }
};

export function Session({ client, sessionId, initialPrompt, onDetach }: Props) {
    const [entries, setEntries] = useState<TimelineEntry[]>([]);
    const [status, setStatus] = useState<AgentStatus>(initialStatus);
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingPermission | null>(null);
    const [now, setNow] = useState(Date.now());

    const idRef = useRef(0);
    const mapsRef = useRef(newMaps());
    const nextId = () => ++idRef.current;

    // Drive the spinner + elapsed-time refresh while the agent is busy.
    useEffect(() => {
        if (status.phase.kind === "idle") return;
        const interval = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(interval);
    }, [status.phase.kind]);

    const apiRef = useRef<TimelineApi | null>(null);
    if (apiRef.current === null) {
        apiRef.current = {
            nextId,
            push: (entry) => {
                const id = nextId();
                setEntries((prev) => [...prev, { ...entry, id }]);
                return id;
            },
            update: (id, patch) => {
                setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            },
            append: (id, piece) => {
                setEntries((prev) =>
                    prev.map((e) => (e.id === id ? { ...e, text: e.text + piece } : e)),
                );
            },
            setStatus,
            maps: mapsRef.current,
        };
    }

    useEffect(() => {
        let cancelled = false;
        const api = apiRef.current!;

        (async () => {
            try {
                await client.request("session.resume", { sessionId, permissionMode: "prompt" });
                if (cancelled) return;
                api.push({ kind: "info", text: `attached to ${sessionId}` });
                if (initialPrompt && initialPrompt.trim().length > 0) {
                    const trimmed = initialPrompt.trim();
                    api.push({ kind: "user", text: trimmed });
                    client.notify({ type: "session.send", sessionId, prompt: trimmed });
                }
            } catch (err) {
                setError(`session.resume failed: ${(err as Error).message}`);
            }
        })();

        const onEvent = (msg: EventMessage) => {
            if (msg.sessionId !== sessionId) return;
            applyEvent(api, msg.event);
        };
        const onPerm = (msg: PermissionRequestMessage) => {
            if (msg.sessionId !== sessionId) return;
            setPending({ requestId: msg.requestId, request: msg.request });
        };
        client.on("event", onEvent);
        client.on("permission.request", onPerm);

        return () => {
            cancelled = true;
            client.off("event", onEvent);
            client.off("permission.request", onPerm);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    const sendPrompt = (prompt: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return;
        apiRef.current!.push({ kind: "user", text: trimmed });
        client.notify({ type: "session.send", sessionId, prompt: trimmed });
        setInput("");
        setStatus((prev) => ({ ...prev, phase: { kind: "thinking" }, since: Date.now() }));
    };

    const answerPermission = (decision: "approve" | "deny") => {
        if (!pending) return;
        client.notify({ type: "permission.reply", requestId: pending.requestId, decision });
        setPending(null);
    };

    useKeyboard((key) => {
        if (pending) return;
        if (key.name === "escape") {
            onDetach();
            return;
        }
        if (key.ctrl && key.name === "c") {
            client.notify({ type: "session.abort", sessionId });
            apiRef.current!.push({ kind: "info", text: "(abort sent)" });
            setStatus((prev) => ({ ...prev, phase: { kind: "idle" }, since: Date.now() }));
            return;
        }
    });

    const statusBar = useMemo(() => {
        const elapsedMs = now - status.since;
        if (status.phase.kind === "idle") {
            return (
                <text fg="gray">
                    <span fg="green">●</span> idle{" "}
                    {status.lastIntent ? <span fg="gray">— last: {status.lastIntent}</span> : null}
                </text>
            );
        }
        const frame = SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length];
        let label = "thinking";
        let detail: string | undefined;
        let color = "yellow";
        switch (status.phase.kind) {
            case "thinking":
                label = "thinking";
                detail = status.phase.detail;
                color = "yellow";
                break;
            case "reasoning":
                label = "reasoning";
                detail = status.lastIntent;
                color = "magenta";
                break;
            case "streaming":
                label = "streaming";
                detail = status.lastIntent;
                color = "cyan";
                break;
            case "tool":
                label = `tool: ${status.phase.name}`;
                detail = status.phase.progress ?? status.lastIntent;
                color = "cyan";
                break;
        }
        const bytesPart =
            status.streamBytes > 0 ? ` ${fmtBytes(status.streamBytes)}` : "";
        return (
            <text>
                <span fg={color}>{frame}</span>{" "}
                <span fg={color} attributes={1}>{label}</span>
                <span fg="gray"> ({fmtElapsed(elapsedMs)}{bytesPart})</span>
                {detail ? <span fg="gray"> — {detail}</span> : null}
            </text>
        );
    }, [status, now]);

    return (
        <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <scrollbox
                style={{ border: true, flexGrow: 1, padding: 1 }}
                title={`Session ${sessionId}`}
            >
                {error ? <text fg="red">{error}</text> : null}
                {entries.map((e) => (
                    <box key={e.id} style={{ flexDirection: "column" }}>
                        <text fg={colorForKind(e.kind)} attributes={e.kind === "intent" ? 1 : 0}>
                            {prefixForEntry(e)}
                            {e.kind === "tool" && e.toolName ? (
                                <>
                                    <span fg="cyan" attributes={1}>{e.toolName}</span>
                                    <span fg="gray">{e.text.slice(e.toolName.length)}</span>
                                </>
                            ) : (
                                e.text
                            )}
                            {e.streaming ? <span fg="gray"> ▍</span> : null}
                        </text>
                        {e.progress ? (
                            <text fg="gray">    {e.progress}</text>
                        ) : null}
                        {e.result ? (
                            <text fg="gray">    {e.result}</text>
                        ) : null}
                    </box>
                ))}
            </scrollbox>

            <box style={{ paddingLeft: 1, paddingRight: 1 }}>{statusBar}</box>

            {pending ? (
                <PermissionPrompt
                    requestId={pending.requestId}
                    request={pending.request}
                    onAnswer={answerPermission}
                />
            ) : (
                <box style={{ border: true, height: 3 }} title="prompt (enter to send, esc to detach, ctrl+c to abort)">
                    <input
                        focused
                        placeholder="Type a message…"
                        value={input}
                        onInput={setInput as never}
                        onSubmit={sendPrompt as never}
                    />
                </box>
            )}
        </box>
    );
}
