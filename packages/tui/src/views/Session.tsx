import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import type { EventMessage, PermissionRequestMessage } from "@tower/protocol";
import type { TowerClient } from "../client.js";
import { getMarkdownStyle } from "../markdownStyle.js";
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
    return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
};

const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

/**
 * Header glyph + color for each entry kind. We use a filled circle for
 * "primary" turns (user / assistant / intent) and an open circle for
 * sub-events (tools, info), so a glance at the timeline reads like a
 * stack of beats.
 */
const headerFor = (
    kind: TimelineEntry["kind"],
    toolStatus?: TimelineEntry["status"],
): { glyph: string; color: string; label: string } => {
    switch (kind) {
        case "user":      return { glyph: "●", color: "green",   label: "You"       };
        case "assistant": return { glyph: "●", color: "white",   label: "Assistant" };
        case "intent":    return { glyph: "●", color: "magenta", label: "Intent"    };
        case "reasoning": return { glyph: "○", color: "gray",    label: "Thinking"  };
        case "tool": {
            const glyph =
                toolStatus === "ok"      ? "✓"
              : toolStatus === "fail"    ? "✗"
              : toolStatus === "running" ? "○"
                                         : "·";
            const color =
                toolStatus === "ok"   ? "green"
              : toolStatus === "fail" ? "red"
                                      : "cyan";
            return { glyph, color, label: "Tool" };
        }
        case "info":      return { glyph: "·", color: "gray",    label: "Info"      };
        case "warning":   return { glyph: "▲", color: "yellow",  label: "Warning"   };
        case "error":     return { glyph: "✗", color: "red",     label: "Error"     };
    }
};

interface EntryProps {
    entry: TimelineEntry;
    isFirst: boolean;
}

const Entry = ({ entry, isFirst }: EntryProps) => {
    const { glyph, color, label } = headerFor(entry.kind, entry.status);
    const showMarkdown = entry.kind === "assistant" && entry.text.length > 0;

    // For tool entries, the label is the tool name itself, in cyan.
    const headerLabel = entry.kind === "tool" && entry.toolName ? entry.toolName : label;

    return (
        <box style={{ flexDirection: "column", marginTop: isFirst ? 0 : 1 }}>
            <text>
                <span fg={color} attributes={1}>{glyph}</span>{" "}
                <span fg={color} attributes={1}>{headerLabel}</span>
                {entry.kind === "tool" && entry.text.length > entry.toolName!.length ? (
                    <span fg="gray">{entry.text.slice(entry.toolName!.length)}</span>
                ) : null}
                {entry.streaming ? <span fg="gray"> ▍</span> : null}
            </text>

            {/* Body — indented two spaces under the header dot. */}
            {showMarkdown ? (
                <box style={{ paddingLeft: 2, marginTop: 0 }}>
                    <markdown
                        content={entry.text}
                        syntaxStyle={getMarkdownStyle()}
                        streaming={entry.streaming === true}
                    />
                </box>
            ) : entry.kind === "assistant" ? null : entry.kind === "tool" ? null : (
                <box style={{ paddingLeft: 2 }}>
                    <text fg={entry.kind === "user" ? "white" : entry.kind === "reasoning" ? "gray" : color}>
                        {entry.text}
                    </text>
                </box>
            )}

            {entry.progress ? (
                <box style={{ paddingLeft: 2 }}>
                    <text fg="gray">↳ {entry.progress}</text>
                </box>
            ) : null}
            {entry.result ? (
                <box style={{ paddingLeft: 2 }}>
                    <text fg="gray">{entry.result}</text>
                </box>
            ) : null}
        </box>
    );
};

export function Session({ client, sessionId, initialPrompt, onDetach }: Props) {
    const [entries, setEntries] = useState<TimelineEntry[]>([]);
    const [status, setStatus] = useState<AgentStatus>(initialStatus);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingPermission | null>(null);
    const [now, setNow] = useState(Date.now());

    const idRef = useRef(0);
    const mapsRef = useRef(newMaps());
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const nextId = () => ++idRef.current;

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
                    setStatus((prev) => ({ ...prev, phase: { kind: "thinking" }, since: Date.now() }));
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

    const sendPrompt = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        apiRef.current!.push({ kind: "user", text: trimmed });
        client.notify({ type: "session.send", sessionId, prompt: trimmed });
        setStatus((prev) => ({ ...prev, phase: { kind: "thinking" }, since: Date.now() }));
    };

    // Wire up textarea submit imperatively — the React wrapper doesn't bridge
    // onSubmit for the textarea, so we set the listener via the ref and pull
    // the buffer's contents on demand.
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.onSubmit = () => {
            const text = ta.plainText;
            if (!text.trim()) return;
            sendPrompt(text);
            ta.setText("");
        };
        return () => { ta.onSubmit = undefined; };
        // sendPrompt closes over sessionId via Props; re-bind whenever that changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

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

    // Textarea key bindings: enter submits, shift+enter inserts a newline.
    // Many terminals can't actually report shift+enter, so we also accept
    // alt+enter (meta+enter) as an alias — that's the convention most coding
    // CLIs adopt.
    const textareaBindings = useMemo(
        () => [
            { name: "return", action: "submit" as const },
            { name: "linefeed", action: "submit" as const },
            { name: "return", shift: true, action: "newline" as const },
            { name: "return", meta: true, action: "newline" as const },
        ],
        [],
    );

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
                detail = status.phase.detail;
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
        const bytesPart = status.streamBytes > 0 ? ` ${fmtBytes(status.streamBytes)}` : "";
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
            {/* Timeline — no border, just a padded scroll area. */}
            <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
                {error ? <text fg="red">✗ {error}</text> : null}
                {entries.map((e, idx) => (
                    <Entry key={e.id} entry={e} isFirst={idx === 0} />
                ))}
            </scrollbox>

            {/* Status bar between timeline and input. */}
            <box style={{ paddingLeft: 1, paddingRight: 1, marginTop: 1, marginBottom: 0 }}>
                {statusBar}
            </box>

            {pending ? (
                <PermissionPrompt
                    requestId={pending.requestId}
                    request={pending.request}
                    onAnswer={answerPermission}
                />
            ) : (
                /* Prompt — only left + right verticals, no top/bottom border. */
                <box
                    style={{
                        border: ["left", "right"],
                        borderColor: "gray",
                        paddingLeft: 1,
                        paddingRight: 1,
                        minHeight: 3,
                    }}
                >
                    <textarea
                        ref={textareaRef as never}
                        focused
                        placeholder="Type a message — enter to send, shift/alt+enter for newline, esc to detach, ctrl+c to abort"
                        keyBindings={textareaBindings as never}
                    />
                </box>
            )}
        </box>
    );
}
