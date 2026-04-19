import { useEffect } from "react";
import { shutdown } from "../shutdown.js";

interface Props {
    url: string;
    error: string | null;
}

/** Renderer-aware shutdown installed by index.tsx. Falls back to a plain exit
 *  if the TUI was loaded outside the normal entry (e.g. tests). */

export function Connecting({ url, error }: Props) {
    useEffect(() => {
        if (error) {
            const t = setTimeout(() => shutdown(1), 50);
            return () => clearTimeout(t);
        }
    }, [error]);

    return (
        <box style={{ border: true, padding: 1, flexDirection: "column" }}>
            <text>tower-tui</text>
            {error ? (
                <>
                    <text fg="red">connection failed</text>
                    <text>{error}</text>
                </>
            ) : (
                <text>Connecting to {url}…</text>
            )}
        </box>
    );
}
