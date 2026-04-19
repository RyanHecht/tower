import { useEffect, useRef, useState } from "react";
import { TowerClient } from "./client.js";
import { Connecting } from "./views/Connecting.js";
import { Launcher } from "./views/Launcher.js";
import { Session } from "./views/Session.js";
import { loadState, saveState } from "./state.js";

type View =
    | { kind: "connecting" }
    | { kind: "launcher" }
    | { kind: "session"; sessionId: string; initialPrompt?: string }
    | { kind: "error"; error: string };

const URL = process.env["TOWER_URL"] ?? "ws://127.0.0.1:8787";
const TOKEN = process.env["TOWER_TOKEN"] ?? "";

export function App() {
    const [view, setView] = useState<View>({ kind: "connecting" });
    const [connectError, setConnectError] = useState<string | null>(null);
    const [lastSessionId, setLastSessionId] = useState<string | null>(null);
    const [routerSessionId, setRouterSessionId] = useState<string | null>(null);
    const clientRef = useRef<TowerClient | null>(null);

    useEffect(() => {
        if (!TOKEN) {
            setConnectError("TOWER_TOKEN env var is required");
            setView({ kind: "error", error: "missing TOWER_TOKEN" });
            return;
        }
        const client = new TowerClient({ url: URL, token: TOKEN });
        clientRef.current = client;
        Promise.all([client.connect(), loadState()])
            .then(async ([, state]) => {
                setLastSessionId(state.lastSessionId ?? null);
                // Best-effort: ask the gateway for the router's sessionId.
                try {
                    const info = await client.routerInfo();
                    setRouterSessionId(info.sessionId);
                } catch {
                    /* router may not be available; continue without the marker */
                }
                // Always open the launcher on a fresh launch — staying
                // pinned to the last session was confusing because there's
                // no obvious way to switch away. The launcher highlights
                // the most recent session at the top so resuming is still
                // one keystroke.
                setView({ kind: "launcher" });
            })
            .catch((err) => {
                setConnectError((err as Error).message);
                setView({ kind: "error", error: (err as Error).message });
            });
        return () => client.close();
    }, []);

    const openSession = (sessionId: string, initialPrompt?: string) => {
        setLastSessionId(sessionId);
        void saveState({ lastSessionId: sessionId, lastView: "session" });
        setView({ kind: "session", sessionId, initialPrompt });
    };

    if (view.kind === "connecting" || view.kind === "error") {
        return <Connecting url={URL} error={view.kind === "error" ? view.error : connectError} />;
    }

    const client = clientRef.current!;

    if (view.kind === "launcher") {
        return (
            <Launcher
                client={client}
                routerSessionId={routerSessionId}
                lastSessionId={lastSessionId}
                onOpen={openSession}
            />
        );
    }

    return (
        <Session
            client={client}
            sessionId={view.sessionId}
            initialPrompt={view.initialPrompt}
        />
    );
}
