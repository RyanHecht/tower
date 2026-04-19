/** Renderer-aware shutdown installed by index.tsx. Falls back to a plain exit
 *  if the TUI was loaded outside the normal entry (e.g. tests). */
export function shutdown(code: number): void {
    const fn = (globalThis as { __towerShutdown?: (code: number) => void }).__towerShutdown;
    if (fn) fn(code);
    else process.exit(code);
}
