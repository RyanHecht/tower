/** Centralised TUI keybindings — referenced by views and the help screen. */
export const KEYS = {
    quit: "q",
    help: "?",
    refresh: "r",
    newSession: "n",
    detach: "escape",
    abort: "ctrl+c",
    approve: "a",
    deny: "d",
    submit: "return",
} as const;

export interface KeyHelp {
    key: string;
    label: string;
}

export const LAUNCHER_HELP: KeyHelp[] = [
    { key: "type", label: "filter list / ask the router" },
    { key: "tab", label: "toggle focus: input ⇄ list" },
    { key: "↑/↓", label: "move list selection" },
    { key: "enter", label: "open highlighted session, or ask router" },
    { key: "ctrl+n", label: "new session (workspace=default)" },
    { key: "?", label: "help" },
    { key: "q", label: "quit (only when input is empty)" },
];

export const SESSION_VIEW_HELP: KeyHelp[] = [
    { key: "type + enter", label: "send prompt" },
    { key: "ctrl+c", label: "abort current run" },
    { key: "esc", label: "detach (session keeps running)" },
];
