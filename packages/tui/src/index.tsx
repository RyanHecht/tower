#!/usr/bin/env node
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.js";

const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
});

// Expose a renderer-aware shutdown for anywhere in the app that needs to exit
// (e.g. fatal connection errors). Without this, calling process.exit() bypasses
// OpenTUI's mouse/altscreen teardown and leaves the terminal in raw +
// mouse-tracking mode.
function shutdown(code: number): void {
    try { renderer.destroy(); } catch { /* ignore */ }
    process.exit(code);
}
(globalThis as { __towerShutdown?: (code: number) => void }).__towerShutdown = shutdown;

process.on("uncaughtException", (err) => {
    try { renderer.destroy(); } catch { /* ignore */ }
    console.error(err);
    process.exit(1);
});
process.on("unhandledRejection", (err) => {
    try { renderer.destroy(); } catch { /* ignore */ }
    console.error(err);
    process.exit(1);
});

createRoot(renderer).render(<App />);
