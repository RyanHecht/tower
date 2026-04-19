import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { EventMessage, PermissionRequestMessage, SessionEvent } from "@tower/protocol";
import type { TowerClient } from "../client.js";
import { PermissionPrompt } from "./PermissionPrompt.js";

interface Props {
    client: TowerClient;
    sessionId: string;
    onDetach: () => void;
}

interface TranscriptLine {
    id: number;
    kind: "assistant" | "tool" | "info" | "error" | "user";
    text: string;
}

interface PendingPermission {
    requestId: string;
    request: PermissionRequestMessage["request"];
}

const eventToLine = (
    nextId: () => number,
    deltaBuf: { current: { id: number; text: string } | null },
    push: (line: TranscriptLine) => void,
    update: (id: number, text: string) => void,
    event: SessionEvent,
): void => {
    const ev = event as { type: string; data?: Record<string, unknown> };
    const data = ev.data ?? {};
    switch (ev.type) {
        case "assistant.message": {
            // Final message — flush any in-flight delta buffer first.
            deltaBuf.current = null;
            const text = String(data["content"] ?? data["message"] ?? "");
            if (text) push({ id: nextId(), kind: "assistant", text });
            return;
        }
        case "assistant.message_delta": {
            const piece = String(data["delta"] ?? data["content"] ?? "");
            if (!piece) return;
            if (!deltaBuf.current) {
                const id = nextId();
                deltaBuf.current = { id, text: piece };
                push({ id, kind: "assistant", text: piece });
            } else {
                deltaBuf.current.text += piece;
                update(deltaBuf.current.id, deltaBuf.current.text);
            }
            return;
        }
        case "tool.execution_start":
            push({
                id: nextId(),
                kind: "tool",
                text: `→ ${String(data["toolName"] ?? "tool")}(${JSON.stringify(data["arguments"] ?? {})})`,
            });
            return;
        case "tool.execution_complete": {
            const ok = data["error"] ? "✗" : "✓";
            push({
                id: nextId(),
                kind: "tool",
                text: `${ok} ${String(data["toolName"] ?? "tool")} done`,
            });
            return;
        }
        case "session.error":
            push({ id: nextId(), kind: "error", text: String(data["message"] ?? "error") });
            return;
        case "session.warning":
        case "session.info":
        case "session.idle":
            // Quiet — uncomment if you want chatty status:
            // push({ id: nextId(), kind: "info", text: `${ev.type}: ${JSON.stringify(data)}` });
            return;
        default:
            return;
    }
};

export function Session({ client, sessionId, onDetach }: Props) {
    const [lines, setLines] = useState<TranscriptLine[]>([]);
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingPermission | null>(null);
    const idRef = useRef(0);
    const deltaBuf = useRef<{ id: number; text: string } | null>(null);
    const nextId = () => ++idRef.current;

    const push = (line: TranscriptLine) => setLines((prev) => [...prev, line]);
    const update = (id: number, text: string) =>
        setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text } : l)));

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await client.request("session.resume", {
                    sessionId,
                    permissionMode: "prompt",
                });
                if (cancelled) return;
                push({ id: nextId(), kind: "info", text: `attached to ${sessionId}` });
            } catch (err) {
                setError(`session.resume failed: ${(err as Error).message}`);
            }
        })();

        const onEvent = (msg: EventMessage) => {
            if (msg.sessionId !== sessionId) return;
            eventToLine(nextId, deltaBuf, push, update, msg.event);
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
        push({ id: nextId(), kind: "user", text: trimmed });
        client.notify({ type: "session.send", sessionId, prompt: trimmed });
        setInput("");
    };

    const answerPermission = (decision: "approve" | "deny") => {
        if (!pending) return;
        client.notify({ type: "permission.reply", requestId: pending.requestId, decision });
        setPending(null);
    };

    useKeyboard((key) => {
        if (pending) return; // PermissionPrompt owns input while a request is pending
        if (key.name === "escape") {
            onDetach();
            return;
        }
        if (key.ctrl && key.name === "c") {
            client.notify({ type: "session.abort", sessionId });
            push({ id: nextId(), kind: "info", text: "(abort sent)" });
            return;
        }
    });

    const lineColor = (kind: TranscriptLine["kind"]) => {
        switch (kind) {
            case "assistant": return "white";
            case "tool":      return "cyan";
            case "info":      return "gray";
            case "error":     return "red";
            case "user":      return "green";
        }
    };

    return (
        <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <scrollbox
                style={{ border: true, flexGrow: 1, padding: 1 }}
                title={`Session ${sessionId}`}
            >
                {error ? <text fg="red">{error}</text> : null}
                {lines.map((l) => (
                    <text key={l.id} fg={lineColor(l.kind)}>
                        {l.kind === "user" ? "❯ " : ""}{l.text}
                    </text>
                ))}
            </scrollbox>
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
