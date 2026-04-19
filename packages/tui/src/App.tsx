import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";

/**
 * Top-level state machine. Real views land in follow-up commits.
 */
export function App() {
    const [view, setView] = useState<"connecting">("connecting");

    useKeyboard((key) => {
        if (key.name === "q" || (key.ctrl && key.name === "c")) {
            process.exit(0);
        }
    });

    useEffect(() => {
        // placeholder lifecycle
    }, []);

    return (
        <box style={{ border: true, padding: 1, flexDirection: "column" }}>
            <text>tower-tui</text>
            <text>view: {view}</text>
            <text>(views land in follow-up commits — q to quit)</text>
        </box>
    );
}
