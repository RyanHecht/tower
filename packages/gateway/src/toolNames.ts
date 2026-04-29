/**
 * Single source of truth for all Tower tool names.
 *
 * Every tool definition and every hardcoded reference to a tool name
 * (e.g., injected prompts, skill files) should import from here.
 * A rename becomes a one-line change.
 */

// ── Vault ──────────────────────────────────────────────────────────────
export const TOWER_VAULT_READ = "tower_vault_read";
export const TOWER_VAULT_WRITE = "tower_vault_write";
export const TOWER_VAULT_APPEND = "tower_vault_append";
export const TOWER_VAULT_LIST = "tower_vault_list";
export const TOWER_VAULT_SEARCH = "tower_vault_search";
export const TOWER_VAULT_REMEMBER = "tower_vault_remember";

// ── Vault inbox ────────────────────────────────────────────────────────
export const TOWER_VAULT_INBOX_ADD = "tower_vault_inbox_add";
export const TOWER_VAULT_INBOX_PENDING = "tower_vault_inbox_pending";
export const TOWER_VAULT_INBOX_DONE = "tower_vault_inbox_done";

// ── Messaging ──────────────────────────────────────────────────────────
export const TOWER_MSG_SEND = "tower_msg_send";
export const TOWER_MSG_INBOX = "tower_msg_inbox";
export const TOWER_MSG_READ = "tower_msg_read";
export const TOWER_MSG_REPLY = "tower_msg_reply";

// ── Display ────────────────────────────────────────────────────────────
export const TOWER_DISPLAY_LAUNCH = "tower_display_launch";
export const TOWER_DISPLAY_STATUS = "tower_display_status";
export const TOWER_DISPLAY_DESTROY = "tower_display_destroy";
export const TOWER_DISPLAY_BROWSER = "tower_display_browser";
export const TOWER_DISPLAY_TERMINAL = "tower_display_terminal";

// ── Sessions ───────────────────────────────────────────────────────────
export const TOWER_SESSION_LIST = "tower_session_list";
