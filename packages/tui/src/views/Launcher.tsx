import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SessionListAllItem } from "@tower/protocol";
import type { TowerClient } from "../client.js";
import { LAUNCHER_HELP } from "../keys.js";
import { useDoubleCtrlCQuit } from "../useDoubleCtrlCQuit.js";

interface Props {
    client: TowerClient;
    routerSessionId: string | null;
    lastSessionId?: string | null;
    onOpen: (sessionId: string, initialPrompt?: string) => void;
}

// Lines starting with this character are routed to the router instead of
// creating a fresh session. Chosen because "?" reads as "ask a question".
const ROUTER_PREFIX = "?";

interface RouteDecision {
    action: "select" | "create" | "give_up";
    sessionId?: string;
    workspace?: string;
    reason?: string;
}

type Focus = "input" | "list";

const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const fmtAge = (d: string | undefined): string => {
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

const matches = (item: SessionListAllItem, q: string): boolean => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
        item.sessionId.toLowerCase().includes(needle) ||
        (item.workspace ?? "").toLowerCase().includes(needle) ||
        (item.summary ?? "").toLowerCase().includes(needle)
    );
};

interface Row {
    item: SessionListAllItem;
    isRouter: boolean;
}

export function Launcher({ client, routerSessionId, lastSessionId, onOpen }: Props) {
    const [items, setItems] = useState<SessionListAllItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [routerError, setRouterError] = useState<string | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const [input, setInput] = useState("");
    const [focus, setFocus] = useState<Focus>("input");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [asking, setAsking] = useState(false);
    const askSeq = useRef(0);

    const refresh = async () => {
        setError(null);
        try {
            const list = await client.listAllSessions<SessionListAllItem>();
            setItems(list);
        } catch (err) {
            setError((err as Error).message);
        }
    };

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Partition into Active vs Archived. The router's own session is rendered
    // inline in the Active group and marked non-selectable.
    const { activeRows, archivedRows, allSelectable } = useMemo(() => {
        const list = items ?? [];
        const filtered = list.filter((s) => matches(s, input));
        const active: Row[] = [];
        const archived: Row[] = [];
        for (const it of filtered) {
            const isRouter = !!routerSessionId && it.sessionId === routerSessionId;
            const row: Row = { item: it, isRouter };
            if (it.isActive || isRouter) active.push(row);
            else archived.push(row);
        }
        // Sort by recency desc within each group.
        const byRecent = (a: Row, b: Row) => {
            const ta = a.item.lastActivityAt ? new Date(a.item.lastActivityAt).getTime() : 0;
            const tb = b.item.lastActivityAt ? new Date(b.item.lastActivityAt).getTime() : 0;
            return tb - ta;
        };
        active.sort(byRecent);
        archived.sort(byRecent);
        // Selectable rows are everything except the router pseudo-row.
        const allSelectable: Row[] = [...active, ...archived].filter((r) => !r.isRouter);
        return { activeRows: active, archivedRows: archived, allSelectable };
    }, [items, input, routerSessionId]);

    // Restore "last session" selection on first non-empty load.
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current) return;
        if (!items || allSelectable.length === 0) return;
        restoredRef.current = true;
        const idx = lastSessionId ? allSelectable.findIndex((r) => r.item.sessionId === lastSessionId) : -1;
        setSelectedIdx(idx >= 0 ? idx : 0);
    }, [items, allSelectable, lastSessionId]);

    // Clamp selection when filter changes the visible set.
    useEffect(() => {
        if (allSelectable.length === 0) {
            setSelectedIdx(0);
        } else if (selectedIdx >= allSelectable.length) {
            setSelectedIdx(allSelectable.length - 1);
        }
    }, [allSelectable.length, selectedIdx]);

    const askRouter = async (prompt: string) => {
        const mySeq = ++askSeq.current;
        setRouterError(null);
        setAsking(true);
        try {
            const decision = await client.routerAsk<RouteDecision>(prompt);
            if (mySeq !== askSeq.current) return; // a newer ask superseded us
            if (decision.action === "select" && decision.sessionId) {
                onOpen(decision.sessionId);
                return;
            }
            if (decision.action === "create") {
                if (decision.sessionId) {
                    onOpen(decision.sessionId);
                    return;
                }
                // Router didn't pre-create; fall back to creating one ourselves
                // in the suggested workspace.
                const workspace = decision.workspace ?? "default";
                try {
                    const created = await client.request<{ sessionId: string }>("session.create", {
                        workspace,
                        permissionMode: "prompt",
                    });
                    onOpen(created.sessionId);
                } catch (err) {
                    setRouterError(`session.create failed: ${(err as Error).message}`);
                }
                return;
            }
            // give_up
            setRouterError(decision.reason ?? "router declined to choose a session");
        } catch (err) {
            if (mySeq !== askSeq.current) return;
            setRouterError((err as Error).message);
        } finally {
            if (mySeq === askSeq.current) setAsking(false);
        }
    };

    const newSession = async (initialPrompt?: string) => {
        try {
            const created = await client.request<{ sessionId: string }>("session.create", {
                workspace: "default",
                permissionMode: "prompt",
            });
            onOpen(created.sessionId, initialPrompt);
        } catch (err) {
            setError(`session.create failed: ${(err as Error).message}`);
        }
    };

    const activate = (row: Row | undefined) => {
        if (!row) return;
        if (row.isRouter) {
            // Selecting the router row directly is a no-op; nudge the user.
            setRouterError("this is the router; type a question above and press enter to chat with it");
            return;
        }
        onOpen(row.item.sessionId);
    };

    const onInputSubmit = (_value: string) => {
        // Enter while input is focused.
        const trimmed = input.trim();
        if (trimmed.length === 0) {
            // Empty input — open the highlighted row if any.
            activate(allSelectable[selectedIdx]);
            return;
        }
        if (trimmed.startsWith(ROUTER_PREFIX)) {
            // Strip the prefix (and any whitespace after it) before asking.
            const question = trimmed.slice(ROUTER_PREFIX.length).trim();
            if (question.length === 0) {
                setRouterError(`type a question after "${ROUTER_PREFIX}"`);
                return;
            }
            void askRouter(question);
            return;
        }
        // Default: spin up a fresh session and send the typed text as its
        // first message.
        void newSession(trimmed);
    };

    const [quitHint, setQuitHint] = useState<string | null>(null);
    const { pressedCtrlC } = useDoubleCtrlCQuit(setQuitHint);

    useKeyboard((key) => {
        if (showHelp) {
            setShowHelp(false);
            return;
        }
        // Double-Ctrl+C exits — same semantics as Copilot CLI / the Session view.
        if (key.ctrl && key.name === "c") {
            pressedCtrlC();
            return;
        }
        // Tab toggles focus regardless of which side we're on. The Input
        // component does not insert a literal tab into its value, so this is
        // safe even with a non-empty input buffer.
        if (key.name === "tab") {
            setFocus((f) => (f === "input" ? "list" : "input"));
            return;
        }
        // ? toggles help unless the input is focused and being typed into.
        if (key.name === "?" && focus === "list") {
            setShowHelp(true);
            return;
        }
        // Ctrl+N — explicit new session in default workspace.
        if (key.ctrl && key.name === "n") {
            void newSession();
            return;
        }
        // Arrow keys move list selection from either focus.
        if (key.name === "down") {
            if (allSelectable.length > 0) setSelectedIdx((i) => Math.min(i + 1, allSelectable.length - 1));
            return;
        }
        if (key.name === "up") {
            if (allSelectable.length > 0) setSelectedIdx((i) => Math.max(i - 1, 0));
            return;
        }
        // Enter from list focus — Input owns Enter while input is focused.
        if (key.name === "return" && focus === "list") {
            activate(allSelectable[selectedIdx]);
            return;
        }
    });

    if (showHelp) {
        return (
            <box style={{ border: true, padding: 1, flexDirection: "column" }} title="Keybinds">
                {LAUNCHER_HELP.map((h) => (
                    <text key={h.key}>
                        <span fg="cyan">{h.key.padEnd(10)}</span> {h.label}
                    </text>
                ))}
                <text> </text>
                <text fg="gray">press any key to close</text>
            </box>
        );
    }

    // Map selectable rows → indices so we can highlight the correct one.
    const selectableSet = new Set(allSelectable.map((r) => r.item.sessionId));
    const selectedSessionId = allSelectable[selectedIdx]?.item.sessionId ?? null;

    const renderRow = (row: Row) => {
        const it = row.item;
        const id = truncate(it.sessionId, 12);
        const ws = truncate(it.workspace ?? "?", 28);
        const age = fmtAge(it.lastActivityAt);
        const isSelected = !row.isRouter && selectableSet.has(it.sessionId) && it.sessionId === selectedSessionId;
        if (row.isRouter) {
            return (
                <text key={it.sessionId} fg="magenta">
                    {"  📞 "}
                    {id}  workspace={ws}  (always-on)
                </text>
            );
        }
        const dot = it.isActive ? "●" : "○";
        const dotColor = it.isActive ? "green" : "gray";
        const prefix = isSelected ? "▸ " : "  ";
        return (
            <text key={it.sessionId} fg={isSelected ? "#d4d4d8" : "gray"} attributes={isSelected ? 1 : 0}>
                {prefix}
                <span fg={dotColor}>{dot}</span> {id}  workspace={ws}  {age} ago
            </text>
        );
    };

    return (
        <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
            <text>
                <span fg="cyan" attributes={1}>What's up?</span>
            </text>

            <box
                style={{
                    border: ["top", "bottom"],
                    borderColor: focus === "input" ? "cyan" : "gray",
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "row",
                    height: 3,
                    marginTop: 1,
                }}
            >
                <box style={{ width: 2 }}>
                    <text>
                        <span fg="#d4d4d8">❯</span>
                    </text>
                </box>
                <input
                    focused={focus === "input"}
                    placeholder={`Type to start a new session, or "${ROUTER_PREFIX} …" to ask the router`}
                    value={input}
                    onInput={setInput as never}
                    onSubmit={onInputSubmit as never}
                    style={{ flexGrow: 1 } as never}
                />
            </box>

            {(() => {
                const trimmed = input.trim();
                if (trimmed.length === 0) return null;
                const isRouter = trimmed.startsWith(ROUTER_PREFIX);
                const payload = isRouter ? trimmed.slice(ROUTER_PREFIX.length).trim() : trimmed;
                const label = asking
                    ? "⏳ Asking router…  "
                    : isRouter
                      ? `▸ Ask router (${ROUTER_PREFIX}): `
                      : "▸ New session: ";
                const color = asking ? "yellow" : isRouter ? "magenta" : "cyan";
                return (
                    <box style={{ marginTop: 1 }}>
                        <text fg={color}>
                            {label}
                            <span fg="#d4d4d8">"{truncate(payload, 60)}"</span>
                        </text>
                    </box>
                );
            })()}

            {routerError ? (
                <box style={{ marginTop: 1 }}>
                    <text fg="red">router: {routerError}</text>
                </box>
            ) : null}

            <box style={{ marginTop: 1, flexDirection: "column", flexGrow: 1 }}>
                {error ? (
                    <text fg="red">{error}</text>
                ) : items === null ? (
                    <text fg="gray">loading sessions…</text>
                ) : (
                    <>
                        <text fg="gray">── Active ──────────────────────────────────</text>
                        {activeRows.length === 0 ? (
                            <text fg="gray">  (none)</text>
                        ) : (
                            activeRows.map(renderRow)
                        )}
                        <text> </text>
                        <text fg="gray">── Archived ────────────────────────────────</text>
                        {archivedRows.length === 0 ? (
                            <text fg="gray">  (none)</text>
                        ) : (
                            archivedRows.map(renderRow)
                        )}
                    </>
                )}
            </box>

            <box style={{ marginTop: 1, flexDirection: "column" }}>
                <text fg="gray">
                    {focus === "input" ? "input" : "list"} • tab: focus list • enter: new session ({ROUTER_PREFIX} = ask router) • ctrl+n: blank • ctrl+c twice: quit
                </text>
                {quitHint ? <text fg="#fbbf24">{quitHint}</text> : null}
            </box>
        </box>
    );
}
