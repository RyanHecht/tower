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
 * Each entry kind decides how it renders. The legend:
 *
 *   ❯ in highlighted bold       → user prompt
 *   ● yellow                    → new assistant message (Markdown body)
 *   ● yellow (italic body)      → assistant.intent
 *   (no header) italic gray     → reasoning trace
 *   ○ cyan                      → tool call in flight
 *   ● green                     → tool call succeeded
 *   ● red                       → tool call failed
 *   ● red                       → session error
 *   ▲ yellow                    → session warning
 *   · gray                      → quiet info line
 */
interface HeaderSpec {
    glyph: string;
    color: string;
    /** Show no header line at all (entry body stands alone). */
    inline?: boolean;
}

const headerFor = (entry: TimelineEntry): HeaderSpec | null => {
    switch (entry.kind) {
        case "user":      return null; // rendered inline with ❯ prefix
        case "assistant": return { glyph: "●", color: "yellow"  };
        case "intent":    return { glyph: "●", color: "yellow"  };
        case "reasoning": return null; // rendered as bare italicised text
        case "tool": {
            switch (entry.status) {
                case "ok":      return { glyph: "●", color: "green" };
                case "fail":    return { glyph: "●", color: "red"   };
                case "running": return { glyph: "○", color: "cyan"  };
                default:        return { glyph: "·", color: "gray"  };
            }
        }
        case "info":      return { glyph: "·", color: "gray"   };
        case "warning":   return { glyph: "▲", color: "yellow" };
        case "error":     return { glyph: "●", color: "red"    };
    }
};

interface EntryProps {
    entry: TimelineEntry;
    isFirst: boolean;
}

const Entry = ({ entry, isFirst }: EntryProps) => {
    const marginTop = isFirst ? 0 : 1;

    // Plain user prompt — bold, prefixed with ❯, no header circle.
    if (entry.kind === "user") {
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text>
                    <span fg="cyan" attributes={1}>❯ </span>
                    <span fg="white" attributes={1}>{entry.text}</span>
                </text>
            </box>
        );
    }

    // Reasoning — render as bare italic gray text with no header at all.
    if (entry.kind === "reasoning") {
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text fg="gray">
                    <i>{entry.text}</i>
                    {entry.streaming ? <span fg="gray"> ▍</span> : null}
                </text>
            </box>
        );
    }

    const header = headerFor(entry)!; // every other kind has a header

    // Tool entries: header line is "● tool_name(args)" with the args in dim
    // gray. Progress / result render below indented.
    if (entry.kind === "tool") {
        const args = entry.toolName ? entry.text.slice(entry.toolName.length) : entry.text;
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text>
                    <span fg={header.color} attributes={1}>{header.glyph} </span>
                    <span fg={header.color}>{entry.toolName ?? "tool"}</span>
                    <span fg="gray">{args}</span>
                </text>
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
    }

    // Assistant message — header dot followed by Markdown body indented under it.
    if (entry.kind === "assistant") {
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text>
                    <span fg={header.color} attributes={1}>{header.glyph}</span>
                </text>
                <box style={{ paddingLeft: 2 }}>
                    {entry.text.length > 0 ? (
                        <markdown
                            content={entry.text}
                            syntaxStyle={getMarkdownStyle()}
                            streaming={entry.streaming === true}
                        />
                    ) : null}
                </box>
            </box>
        );
    }

    // Assistant intent — single italic yellow line, no body.
    if (entry.kind === "intent") {
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text>
                    <span fg={header.color} attributes={1}>{header.glyph} </span>
                    <span fg={header.color}><i>{entry.text}</i></span>
                </text>
            </box>
        );
    }

    // info / warning / error — single line, header inline with the text.
    return (
        <box style={{ flexDirection: "column", marginTop }}>
            <text>
                <span fg={header.color} attributes={1}>{header.glyph} </span>
                <span fg={header.color}>{entry.text}</span>
            </text>
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
                        border: ["top", "bottom"],
                        borderColor: "gray",
                        paddingLeft: 1,
                        paddingRight: 1,
                        flexDirection: "row",
                        minHeight: 3,
                    }}
                >
                    <box style={{ width: 2, paddingTop: 0 }}>
                        <text>
                            <span fg="cyan" attributes={1}>❯</span>
                        </text>
                    </box>
                    <textarea
                        ref={textareaRef as never}
                        focused
                        placeholder="Type a message — enter to send, shift/alt+enter for newline, esc to detach, ctrl+c to abort"
                        keyBindings={textareaBindings as never}
                        style={{ flexGrow: 1 } as never}
                    />
                </box>
            )}
        </box>
    );
}
