---
name: tasks
description: >
  Task management via the vault. Read, add, update, and complete tasks
  stored in the vault knowledge base. Task format and location are
  defined in _schema.md.
---

# Tasks

Tasks are managed as markdown in the vault. The default location and
format are defined in `_schema.md` — check it first to see where tasks
live and what format they use.

## Reading tasks

```
tower_vault_read(path: "wiki/tasks.md")
```

## Adding a task

```
tower_vault_append(
  path: "wiki/tasks.md",
  content: "- [ ] **Buy groceries** — milk, eggs, bread (added: 2026-04-29, priority: P3)"
)
```

## Completing a task

Read the file, update the checkbox, write it back:

```
tower_vault_read(path: "wiki/tasks.md")
# Find the task line, change "- [ ]" to "- [x]"
tower_vault_write(path: "wiki/tasks.md", content: "...updated content...")
```

## Tips

- Always check `_schema.md` for the current task format and location.
- Use `tower_vault_append` to add tasks — never overwrite the whole file
  just to add one task.
- When completing tasks, read first then write — use `tower_vault_write`
  since you need to modify an existing line.
- Include source references when tasks come from inbox items or conversations.
- Prioritize using the format defined in the schema (e.g., P1-P4 levels).
