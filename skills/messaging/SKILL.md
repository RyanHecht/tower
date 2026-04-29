---
name: messaging
description: >
  Send and receive messages between Tower sessions. Supports direct
  messages, group messages, channels, threading, and priority levels.
  Messages are stored as markdown files and persist across restarts.
---

# Messaging

You can communicate with other Tower sessions using the message board.
Messages are stored as markdown files in `data/messages/` and persist
across container restarts.

## Tools

### `tower_msg_send` — Send a message

```
tower_msg_send(to, message, priority?, tags?)
```

- `to`: Session ID, array of session IDs, or channel name (prefix with `#`)
- `message`: Message body (markdown supported)
- `priority`: `"urgent"` | `"normal"` (default) | `"low"`
- `tags`: Optional tags for filtering

**Priority behavior:**
- `urgent` — message is stored AND immediately injected as a prompt
  into any online recipients. Use sparingly.
- `normal` — stored in inbox. Recipient sees it when they check.
- `low` — stored but excluded from unread counts. For FYI/background info.

### `tower_msg_inbox` — Check your inbox

```
tower_msg_inbox(unreadOnly?, includeLow?, tag?, limit?)
```

Returns messages addressed to this session, newest first. Defaults to
unread normal+urgent messages.

### `tower_msg_read` — Read a full message

```
tower_msg_read(messageId)
```

Returns the full message content and marks it as read.

### `tower_msg_reply` — Reply to a message

```
tower_msg_reply(messageId, message, priority?)
```

Sends a reply to the original sender and all recipients (group reply).
Creates a threaded conversation.

### `tower_session_list` — Discover sessions

```
tower_session_list()
```

Lists all sessions with their ID, summary, workspace, and active status.
Use this to find who to message.

## IMPORTANT: Responding to messages

When you receive a message from another session (either via tower_msg_inbox
or injected as a prompt), you MUST respond using `tower_msg_reply` — not by
just answering in your own conversation. The sender is a **different
session** and cannot see your conversation output. Only `tower_msg_reply`
delivers your response back to them.

```
1. You receive: "[TOWER MESSAGE — id: msg_abc123, from: session-X ...]"
2. Do whatever work is needed to answer
3. tower_msg_reply(messageId: "msg_abc123", message: "Here's what I found: ...")
```

## Patterns

**Delegate a task:**
```
1. tower_session_list() — find the right session
2. tower_msg_send(to: "session-id", message: "please research X", tags: ["research"])
3. Later: tower_msg_inbox() to check for replies
```

**Check on progress:**
```
1. tower_msg_send(to: "session-id", message: "status update please?", priority: "normal")
2. tower_msg_inbox(tag: "status") to read the response
```

**Broadcast to a channel:**
```
tower_msg_send(to: "#all", message: "build is broken, check CI", priority: "urgent")
```

**Start your turn by checking messages:**
```
tower_msg_inbox() — see if anyone sent you something
```

## Message files

Messages are plain markdown files at `data/messages/msg_*.md` with YAML
frontmatter. You can also read them directly with `view` or `grep` if
the tools aren't available.
