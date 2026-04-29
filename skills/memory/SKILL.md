---
name: memory
description: >
  Persistent knowledge vault for Tower. Store facts, recall information,
  and maintain a self-editing core memory that persists across all sessions.
  Git-backed, Obsidian-compatible, human-editable.
---

# Memory

You have access to a persistent knowledge vault backed by git. Facts you
store here survive across sessions, container restarts, and are shared
with every Tower session. The vault is stored as plain markdown files
that the user can browse and edit directly.

## Core Memory (always present)

Three sections are **always injected into your system prompt**:

- `user` — who the user is, key facts about them
- `preferences` — how the user likes things done
- `context` — current projects, goals, priorities

These are small (keep under 1-2KB total) and always available. You
should **self-edit** them as you learn — don't just append, REWRITE
sections to keep them current and concise.

### Reading core memory
```
tower_vault_list(path: "_core")         — list core memory files
tower_vault_read(path: "_core/user.md") — read one section
```

### Updating core memory (self-editing)
```
tower_vault_write(
  path: "_core/user.md",
  content: "# User\n\n- Name: Ryan\n- Prefers TypeScript\n- Lives in Orlando"
)
```

**IMPORTANT:** `tower_vault_write` REPLACES the entire file. Read it
first, incorporate changes, then write the updated version. Don't lose
existing facts.

## Archival Memory (searched on demand)

For everything beyond core memory, use `tower_vault_remember` to store facts
in topic-organized files:

```
tower_vault_remember(
  fact: "Bob was promoted to VP in April 2026",
  topic: "people/bob"
)
```

Facts are appended to `_memory/<topic>.md` and git-committed. Topics
create the file structure organically:
- `people/bob` → `_memory/people/bob.md`
- `topics/rust` → `_memory/topics/rust.md`
- `topics/general` → default when no topic given

## Recalling Information

```
tower_vault_search(query: "Bob's role")
```

Searches across all vault files (core memory, archival memory, session
summaries) using grep. Returns matching lines with file paths.

## When to Remember

Store facts when you learn something that would be useful in future
sessions:
- User preferences and personal info
- Project decisions and architectural choices
- People and their roles/relationships
- Outcomes of research or investigations

**Update core memory** when you learn something fundamental about the
user (name, preferences, current projects). These facts matter for
every future interaction.

**Use archival memory** for everything else — detailed notes, topic
research, people profiles. These are searched on demand, not always
loaded.

## Vault File Access

For direct file operations:
```
tower_vault_list()                     — browse the vault
tower_vault_read(path: "_memory/topics/rust.md") — read a file
tower_vault_write(path: "...", content: "...") — write a file
```

## The Vault is Git-Backed

Every write is auto-committed. The user can:
- `git log data/vault/` to see what you've learned over time
- Edit files directly and the changes take effect immediately
- Browse the vault in Obsidian (it's compatible)

## Tips

- Keep core memory concise — it's in every prompt
- Use specific topics for archival memory — avoid dumping everything
  in "general"
- When you learn a correction ("actually, Bob is a VP now, not a
  chemist"), UPDATE the existing fact rather than appending alongside it
- Check `tower_vault_search` before storing — avoid duplicates
