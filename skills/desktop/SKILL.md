---
name: desktop
description: >
  Interact with the virtual desktop: launch terminal emulators, control the
  mouse and keyboard, take screenshots, and manage windows. Works with any
  GUI application running on the display, not just browsers.
---

# Desktop Skill

You have access to a virtual desktop (Xvfb + window manager + VNC) that you
can use to run and interact with GUI applications. The user can watch what
you're doing in real-time via the noVNC URL.

## Quick Start

### Step 1: Launch the virtual display

Call the `tower_display_launch` tool (no arguments). This starts the virtual
desktop and returns a noVNC URL the user can open to watch.

### Step 2: Launch an application

- **Terminal**: Call `tower_display_terminal` to open a terminal emulator (xterm)
  on the display. Use this for interactive CLI tools, TUI applications,
  or anything that runs in a terminal.
- **Browser**: Call `tower_display_browser` to open Chromium on the display.
  See the `browser` skill for detailed browser automation guidance.
- **Other apps**: Use bash to launch any GUI application with the display's
  `DISPLAY` env var (from `tower_display_status`).

### Step 3: Interact with the application

Use the **computer-use** tools to interact with anything on the display:

- `screenshot` — See what's currently on screen (returns a PNG image)
- `mouse_click(x, y)` — Click at coordinates
- `mouse_move(x, y)` — Move the cursor
- `mouse_drag(startX, startY, endX, endY)` — Click and drag
- `type_text(text)` — Type text at the cursor position
- `press_key(keys)` — Press keys or combos (`Return`, `ctrl+c`, `alt+Tab`)
- `scroll(x, y, direction)` — Scroll the mouse wheel
- `list_windows` — List all visible windows with IDs, titles, and geometry
- `focus_window(windowId)` — Bring a window to the front
- `get_cursor_position` — Get current cursor coordinates
- `get_screen_size` — Get display dimensions

## Workflow: Terminal Applications

1. `tower_display_launch` → start the desktop
2. `tower_display_terminal` → open a terminal
3. `screenshot` → see the terminal
4. `type_text("ls -la")` + `press_key("Return")` → run a command
5. `screenshot` → see the output

For interactive TUI apps (vim, htop, top, etc.):
1. Launch the app: `type_text("vim myfile.txt")` + `press_key("Return")`
2. Take screenshots to see the state
3. Use `press_key` for vim commands: `press_key("i")` to enter insert mode,
   `press_key("Escape")` to exit, `type_text(":wq")` + `press_key("Return")` to save

## Workflow: General GUI Applications

1. `tower_display_launch` → start the desktop
2. Launch the app via bash: `DISPLAY=:10 nohup myapp > /tmp/myapp.log 2>&1 &`
3. `screenshot` → see the app
4. Use `mouse_click`, `type_text`, `press_key` to interact
5. `list_windows` to find window IDs, `focus_window` to switch between apps

## Tips

- **Always screenshot first** before interacting — you need to see the
  current state to know where to click or what to type.
- Key names for `press_key`: `Return`, `Tab`, `Escape`, `BackSpace`,
  `Delete`, `space`, `Home`, `End`, `Page_Up`, `Page_Down`,
  `Up`, `Down`, `Left`, `Right`, `F1`–`F12`.
- Modifier combos: `ctrl+c`, `ctrl+shift+t`, `alt+F4`, `super+d`.
- The noVNC URL lets the user watch in real-time and take over input
  if needed.

## Available Tools

| Tool | Purpose |
|------|---------|
| `tower_display_launch` | Start the virtual desktop (must call first) |
| `tower_display_terminal` | Open a terminal emulator on the display |
| `tower_display_browser` | Open Chromium on the display |
| `tower_display_status` | Check if a display is running |
| `tower_display_destroy` | Shut down the display and all apps on it |
| `screenshot` | Capture the display (computer-use MCP) |
| `mouse_click` | Click at coordinates (computer-use MCP) |
| `type_text` | Type text (computer-use MCP) |
| `press_key` | Press key combos (computer-use MCP) |
| `list_windows` | List windows (computer-use MCP) |
