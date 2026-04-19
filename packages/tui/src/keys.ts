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

export const SESSION_LIST_HELP: KeyHelp[] = [
    { key: "↑/↓", label: "navigate" },
    { key: "enter", label: "open session" },
    { key: "n", label: "new session (workspace=default)" },
    { key: "r", label: "refresh" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
];

export const SESSION_VIEW_HELP: KeyHelp[] = [
    { key: "type + enter", label: "send prompt" },
    { key: "ctrl+c", label: "abort current run" },
    { key: "esc", label: "detach (session keeps running)" },
];
