import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SelectOption } from "@opentui/core";
import type { TowerClient } from "../client.js";
import { SESSION_LIST_HELP } from "../keys.js";

interface SessionRow {
    sessionId: string;
    summary?: string;
    workspace?: string;
    cwd?: string;
    modifiedTime?: string | Date;
    context?: { cwd?: string };
}

interface Props {
    client: TowerClient;
    routerSessionId: string | null;
    lastSessionId?: string | null;
    onOpen: (sessionId: string) => void;
    onQuit: () => void;
}

const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const fmtAge = (d: string | Date | undefined): string => {
    if (!d) return "?";
    const ms = Date.now() - new Date(d).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "?";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
};

export function SessionList({ client, routerSessionId, lastSessionId, onOpen, onQuit }: Props) {
    const [sessions, setSessions] = useState<SessionRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const refresh = async () => {
        setError(null);
        try {
            const list = await client.request<SessionRow[]>("session.list");
            setSessions(list);
            // Restore the last-opened session as the initial selection when present.
            const restoreIdx = lastSessionId ? list.findIndex((s) => s.sessionId === lastSessionId) : -1;
            setSelectedIndex(restoreIdx >= 0 ? restoreIdx : 0);
        } catch (err) {
            setError((err as Error).message);
        }
    };

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useKeyboard((key) => {
        if (showHelp) {
            setShowHelp(false);
            return;
        }
        if (key.name === "q") return onQuit();
        if (key.name === "?") return setShowHelp(true);
        if (key.name === "r") return void refresh();
        if (key.name === "n") {
            void (async () => {
                try {
                    const created = await client.request<{ sessionId: string }>("session.create", {
                        workspace: "default",
                        permissionMode: "prompt",
                    });
                    onOpen(created.sessionId);
                } catch (err) {
                    setError(`session.create failed: ${(err as Error).message}`);
                }
            })();
            return;
        }
        if (key.name === "return" && sessions && sessions.length > 0) {
            const row = sessions[selectedIndex];
            if (row) onOpen(row.sessionId);
        }
    });

    const options: SelectOption[] = useMemo(() => {
        if (!sessions) return [];
        return sessions.map((s) => {
            const isRouter = routerSessionId && s.sessionId === routerSessionId;
            const prefix = isRouter ? "📞 " : "   ";
            const ws = s.workspace ?? s.context?.cwd ?? s.cwd ?? "?";
            const name = `${prefix}${truncate(s.sessionId, 12)}  ${truncate(ws, 28)}  ${fmtAge(s.modifiedTime)}`;
            return {
                name,
                description: s.summary ?? "",
                value: s.sessionId,
            };
        });
    }, [sessions, routerSessionId]);

    if (showHelp) {
        return (
            <box style={{ border: true, padding: 1, flexDirection: "column" }} title="Keybinds">
                {SESSION_LIST_HELP.map((h) => (
                    <text key={h.key}>
                        <span fg="cyan">{h.key.padEnd(8)}</span> {h.label}
                    </text>
                ))}
                <text> </text>
                <text fg="gray">press any key to close</text>
            </box>
        );
    }

    return (
        <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <box style={{ border: true, padding: 1 }} title="Sessions">
                {error ? (
                    <text fg="red">{error}</text>
                ) : sessions === null ? (
                    <text>loading…</text>
                ) : sessions.length === 0 ? (
                    <text fg="gray">no sessions yet — press n to create one</text>
                ) : (
                    <select
                        focused
                        options={options}
                        onChange={(idx) => setSelectedIndex(idx)}
                        style={{ height: Math.min(options.length + 1, 20) }}
                    />
                )}
            </box>
            <box style={{ paddingLeft: 1 }}>
                <text fg="gray">enter=open  n=new (workspace=default)  r=refresh  ?=help  q=quit</text>
            </box>
        </box>
    );
}
