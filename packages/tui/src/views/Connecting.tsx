import { useEffect } from "react";

interface Props {
    url: string;
    error: string | null;
}

export function Connecting({ url, error }: Props) {
    useEffect(() => {
        if (error) {
            const t = setTimeout(() => process.exit(1), 50);
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
