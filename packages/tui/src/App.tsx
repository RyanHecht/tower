import { useEffect, useRef, useState } from "react";
import { TowerClient } from "./client.js";
import { Connecting } from "./views/Connecting.js";
import { SessionList } from "./views/SessionList.js";

type View =
    | { kind: "connecting" }
    | { kind: "list" }
    | { kind: "session"; sessionId: string }
    | { kind: "error"; error: string };

const URL = process.env["TOWER_URL"] ?? "ws://127.0.0.1:8080";
const TOKEN = process.env["TOWER_TOKEN"] ?? "";

export function App() {
    const [view, setView] = useState<View>({ kind: "connecting" });
    const [connectError, setConnectError] = useState<string | null>(null);
    const clientRef = useRef<TowerClient | null>(null);

    useEffect(() => {
        if (!TOKEN) {
            setConnectError("TOWER_TOKEN env var is required");
            setView({ kind: "error", error: "missing TOWER_TOKEN" });
            return;
        }
        const client = new TowerClient({ url: URL, token: TOKEN });
        clientRef.current = client;
        client
            .connect()
            .then(() => setView({ kind: "list" }))
            .catch((err) => {
                setConnectError((err as Error).message);
                setView({ kind: "error", error: (err as Error).message });
            });
        return () => client.close();
    }, []);

    if (view.kind === "connecting" || view.kind === "error") {
        return <Connecting url={URL} error={view.kind === "error" ? view.error : connectError} />;
    }

    if (view.kind === "list") {
        const client = clientRef.current!;
        return (
            <SessionList
                client={client}
                routerSessionId={null}
                onOpen={(sessionId) => setView({ kind: "session", sessionId })}
                onQuit={() => process.exit(0)}
            />
        );
    }

    // view.kind === "session" — Session view lands in a follow-up commit.
    return (
        <box style={{ border: true, padding: 1, flexDirection: "column" }} title={`Session ${view.sessionId}`}>
            <text>(session view lands in follow-up commit)</text>
            <text fg="gray">esc to detach — currently no-op</text>
        </box>
    );
}
