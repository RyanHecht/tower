import type { PermissionRequest } from "@tower/protocol";

interface Props {
    requestId: string;
    request: PermissionRequest;
    onAnswer: (decision: "approve" | "deny") => void;
}

/** Render a one-line summary of the request for whichever kind it is. */
function summarise(req: PermissionRequest): string {
    const r = req as Record<string, unknown>;
    switch (req.kind) {
        case "shell":
            return `shell: ${String(r["command"] ?? "?")}`;
        case "write":
            return `write: ${String(r["fileName"] ?? r["path"] ?? "?")}`;
        case "read":
            return `read: ${String(r["fileName"] ?? r["path"] ?? "?")}`;
        case "url":
            return `url: ${String(r["url"] ?? r["host"] ?? "?")}`;
        case "mcp":
            return `mcp: ${String(r["server"] ?? "?")}/${String(r["tool"] ?? "?")}`;
        case "custom-tool":
            return `tool: ${String(r["toolName"] ?? "?")}`;
        default:
            return JSON.stringify(req);
    }
}

export function PermissionPrompt({ requestId, request, onAnswer }: Props) {
    return (
        <box
            style={{ border: true, padding: 1, flexDirection: "column", borderColor: "yellow" }}
            title={`Permission request (${request.kind})`}
        >
            <text>{summarise(request)}</text>
            <text fg="gray">id={requestId}</text>
            <text> </text>
            <text>
                <span fg="green">[a]pprove</span>   <span fg="red">[d]eny</span>
            </text>
            {/* Key handling lives in the parent (Session) so it can short-circuit
                input focus. This component is purely presentational. */}
            <Hidden onAnswer={onAnswer} />
        </box>
    );
}

import { useKeyboard } from "@opentui/react";

function Hidden({ onAnswer }: { onAnswer: (d: "approve" | "deny") => void }) {
    useKeyboard((key) => {
        if (key.name === "a") onAnswer("approve");
        else if (key.name === "d") onAnswer("deny");
    });
    return null;
}
