/** Centralised TUI keybindings — referenced by views and the help screen. */
export const KEYS = {
    help: "?",
    refresh: "r",
    newSession: "n",
    abort: "escape",
    copy: "ctrl+c",
    quit: "ctrl+c×2",
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
    { key: "ctrl+c×2", label: "quit (press Ctrl+C twice within ~1.5s)" },
];

export const SESSION_VIEW_HELP: KeyHelp[] = [
    { key: "type + enter", label: "send prompt" },
    { key: "esc", label: "abort current run" },
    { key: "ctrl+c", label: "copy selection" },
    { key: "ctrl+c×2", label: "quit (press Ctrl+C twice within ~1.5s)" },
];
