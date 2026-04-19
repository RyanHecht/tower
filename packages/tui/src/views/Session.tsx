import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
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
        case "assistant": return { glyph: "●", color: "#7dd3fc" }; // sky-300
        case "intent":    return { glyph: "●", color: "#7dd3fc" };
        case "reasoning": return { glyph: "○", color: "gray"    };
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

    // Plain user prompt — soft off-white, prefixed with ❯, no header circle.
    if (entry.kind === "user") {
        return (
            <box style={{ flexDirection: "column", marginTop }}>
                <text>
                    <span fg="#d4d4d8">❯ </span>
                    <span fg="#d4d4d8">{entry.text}</span>
                </text>
            </box>
        );
    }

    // Reasoning — outlined circle + italic gray text inline.
    if (entry.kind === "reasoning") {
        return (
            <box style={{ flexDirection: "row", marginTop }}>
                <box style={{ width: 2 }}>
                    <text><span fg="gray">○</span></text>
                </box>
                <box style={{ flexGrow: 1 }}>
                    <text fg="gray">
                        <i>{entry.text}</i>
                        {entry.streaming ? <span fg="gray"> ▍</span> : null}
                    </text>
                </box>
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

    // Assistant message — circle and markdown share a row; markdown wraps
    // under itself to the right of the circle so the first line sits on the
    // same line as the dot.
    if (entry.kind === "assistant") {
        return (
            <box style={{ flexDirection: "row", marginTop }}>
                <box style={{ width: 2 }}>
                    <text><span fg={header.color} attributes={1}>{header.glyph}</span></text>
                </box>
                <box style={{ flexGrow: 1 }}>
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

    // Assistant intent — single italic line in the header color.
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
    const entriesRef = useRef<TimelineEntry[]>([]);
    if (apiRef.current === null) {
        apiRef.current = {
            nextId,
            push: (entry) => {
                const id = nextId();
                setEntries((prev) => {
                    const next = [...prev, { ...entry, id }];
                    entriesRef.current = next;
                    return next;
                });
                return id;
            },
            insertAt: (index, entry) => {
                const id = nextId();
                setEntries((prev) => {
                    const i = Math.max(0, Math.min(index, prev.length));
                    const next = [...prev.slice(0, i), { ...entry, id }, ...prev.slice(i)];
                    entriesRef.current = next;
                    return next;
                });
                return id;
            },
            update: (id, patch) => {
                setEntries((prev) => {
                    const next = prev.map((e) => (e.id === id ? { ...e, ...patch } : e));
                    entriesRef.current = next;
                    return next;
                });
            },
            append: (id, piece) => {
                setEntries((prev) => {
                    const next = prev.map((e) =>
                        e.id === id ? { ...e, text: e.text + piece } : e,
                    );
                    entriesRef.current = next;
                    return next;
                });
            },
            setStatus,
            entryCount: () => entriesRef.current.length,
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

    const [inputRows, setInputRows] = useState(1);
    const MAX_INPUT_ROWS = 10;

    // Wire up textarea submit imperatively — the React wrapper doesn't bridge
    // onSubmit for the textarea, so we set the listener via the ref and pull
    // the buffer's contents on demand.
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.onSubmit = () => {
            const text = ta.plainText;
            // Backslash-continuation: if the buffer ends with "\", treat that
            // as the user asking for a soft newline (Claude-Code style). Most
            // terminals report shift+enter identically to enter, so this gives
            // us a universal way to add another line.
            if (text.endsWith("\\")) {
                ta.setText(text.slice(0, -1));
                ta.cursorOffset = text.length - 1;
                (ta as unknown as { newLine: () => void }).newLine();
                setInputRows(Math.min(MAX_INPUT_ROWS, ta.lineCount));
                return;
            }
            if (!text.trim()) return;
            sendPrompt(text);
            ta.setText("");
            setInputRows(1);
        };
        // Track content height so the prompt frame grows in lock-step with
        // the buffer (Yoga's measure-func cache otherwise lags by one line,
        // making the box appear to grow only every other newline).
        ta.onContentChange = () => {
            setInputRows(Math.min(MAX_INPUT_ROWS, Math.max(1, ta.lineCount)));
        };
        // Keep keyboard focus pinned to the prompt no matter where the user
        // clicks. Mouse-wheel scrolling on the timeline is dispatched by hit
        // position rather than focus, so this doesn't break scrolling.
        const refocus = () => {
            queueMicrotask(() => ta.focus());
        };
        ta.on("blurred", refocus);
        return () => {
            ta.onSubmit = undefined;
            ta.onContentChange = undefined;
            ta.off("blurred", refocus);
        };
        // sendPrompt closes over sessionId via Props; re-bind whenever that changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    const answerPermission = (decision: "approve" | "deny") => {
        if (!pending) return;
        client.notify({ type: "permission.reply", requestId: pending.requestId, decision });
        setPending(null);
    };

    const renderer = useRenderer();

    useKeyboard((key) => {
        if (pending) return;
        if (key.name === "escape") {
            onDetach();
            return;
        }
        if (key.ctrl && key.name === "c") {
            // If the user has selected text (either inside the textarea or
            // anywhere in the timeline), copy it to the system clipboard via
            // OSC52 instead of aborting the turn.
            const ta = textareaRef.current;
            const taSel = ta?.hasSelection() ? ta.getSelectedText() : "";
            const docSel =
                renderer.hasSelection ? renderer.getSelection()?.getSelectedText() ?? "" : "";
            const selected = taSel || docSel;
            if (selected) {
                renderer.copyToClipboardOSC52(selected);
                apiRef.current!.push({
                    kind: "info",
                    text: `(copied ${selected.length} char${selected.length === 1 ? "" : "s"})`,
                });
                return;
            }
            client.notify({ type: "session.abort", sessionId });
            apiRef.current!.push({ kind: "info", text: "(abort sent)" });
            setStatus((prev) => ({ ...prev, phase: { kind: "idle" }, since: Date.now() }));
            return;
        }
    });

    // Textarea key bindings: enter submits, shift+enter / alt+enter / ctrl+j
    // insert newlines. Many terminals report enter and shift+enter identically
    // (both as plain "\r"), so we also support trailing-backslash continuation
    // (handled in the submit handler below) as a universal fallback.
    const textareaBindings = useMemo(
        () => [
            { name: "return", action: "submit" as const },
            { name: "return", shift: true, action: "newline" as const },
            { name: "return", meta: true, action: "newline" as const },
            // ctrl+j arrives as a "linefeed" key which the textarea defaults
            // already map to "newline" — no override needed. We just don't
            // remap "linefeed" to submit.
        ],
        [],
    );

    const statusBar = useMemo(() => {
        const elapsedMs = now - status.since;
        // Don't render anything when idle — the prompt itself is the
        // "ready for input" indicator. The status bar only earns its space
        // while the agent is actively working.
        if (status.phase.kind === "idle") return null;
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
            <scrollbox
                stickyScroll
                stickyStart="bottom"
                style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}
            >
                {error ? <text fg="red">✗ {error}</text> : null}
                {entries.map((e, idx) => (
                    <Entry key={e.id} entry={e} isFirst={idx === 0} />
                ))}
            </scrollbox>

            {/* Status bar between timeline and input — only present while
                the agent is doing work. */}
            {statusBar ? (
                <box style={{ paddingLeft: 1, paddingRight: 1, marginTop: 1, marginBottom: 0 }}>
                    {statusBar}
                </box>
            ) : null}

            {pending ? (
                <PermissionPrompt
                    requestId={pending.requestId}
                    request={pending.request}
                    onAnswer={answerPermission}
                />
            ) : (
                /* Prompt — only top + bottom borders, height tracks content. */
                <box
                    style={{
                        border: ["top", "bottom"],
                        borderColor: "gray",
                        paddingLeft: 1,
                        paddingRight: 1,
                        flexDirection: "row",
                        height: inputRows + 2,
                    }}
                >
                    <box style={{ width: 2, paddingTop: 0 }}>
                        <text>
                            <span fg="#d4d4d8">❯</span>
                        </text>
                    </box>
                    <textarea
                        ref={textareaRef as never}
                        focused
                        placeholder='Type a message — enter to send; shift/alt+enter, ctrl+j, or trailing "\" for newline; esc to detach; ctrl+c to abort'
                        keyBindings={textareaBindings as never}
                        style={{ flexGrow: 1 } as never}
                    />
                </box>
            )}
        </box>
    );
}
