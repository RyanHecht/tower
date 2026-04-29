---
name: browser
description: >
  Browse the web using a real headed Chromium browser on a virtual desktop.
  Supports navigation, clicking, typing, screenshots, and full page interaction.
  The user can watch the browser in real-time via noVNC.
---

# Browser Skill

You have access to a virtual desktop with a headed Chromium browser for web
browsing, automation, and interaction. This is a REAL browser (not headless),
which means it works with sites that detect and block headless browsers.

## Quick Start

### Step 1: Launch the virtual display

Call the `tower_display_launch` tool (no arguments). This starts the virtual
desktop that the browser renders on. It returns a noVNC URL the user can
open to watch.

### Step 2: Launch Chromium

Call the `tower_display_browser` tool. This starts Chromium on the display with
a per-session profile (logins and cookies persist across sessions). You can
optionally pass a `url` parameter to open a specific page.

The tool returns:
- `cdpPort` — Chrome DevTools Protocol port for direct browser control
- `chromiumProfileDir` — per-session profile directory
- `noVncUrl` — URL for the user to watch

### Step 3: Interact with the page

**Primary method — Playwright MCP tools** (fastest, most reliable):
- `browser_navigate(url)` — go to a URL
- `browser_click(element)` — click an element
- `browser_type(element, text)` — type into an input
- `browser_snapshot` — get the accessibility tree (structured page content)
- `browser_take_screenshot` — capture the browser viewport

**Alternative — CDP direct control** (for advanced use cases):

List open tabs:
```bash
curl -s http://localhost:<cdpPort>/json/list
```

Navigate via CDP:
```bash
curl -s http://localhost:<cdpPort>/json/list | python3 -c "
import sys, json, urllib.request
tabs = json.load(sys.stdin)
tab_id = tabs[0]['id']
urllib.request.urlopen(f'http://localhost:<cdpPort>/json/navigate/{tab_id}?url=https://example.com')
print('Navigated')
"
```

**Alternative — Computer-use tools** (for visual interaction):
- `screenshot` — full display screenshot
- `mouse_click(x, y)` — click at pixel coordinates
- `type_text(text)` — type text
- `press_key(keys)` — press key combinations

## Available tools

- `tower_display_launch` — start the virtual desktop (MUST call first)
- `tower_display_browser` — start Chromium on the display
- `tower_display_terminal` — start a terminal emulator on the display
- `tower_display_status` — check if a display is running
- `tower_display_destroy` — shut down the display and all apps on it
- Playwright MCP tools — `browser_navigate`, `browser_click`, `browser_snapshot`, etc.
- Computer-use tools — `screenshot`, `mouse_click`, `type_text`, `press_key`, etc.

## Tips

- The user can watch what you're doing in real-time by opening the noVNC
  URL returned by `tower_display_launch`.
- Prefer **Playwright MCP tools** for structured web interaction — they're
  faster and more reliable than screenshot-based approaches.
- Use **computer-use tools** when you need to interact with non-browser
  elements (e.g., browser dialogs, desktop notifications) or when
  Playwright can't reach what you need.
- Use `xdotool` via bash for keyboard/mouse input outside of both
  Playwright and computer-use tools.
- Always check if the browser is running with `ps aux | grep chromium`
  before trying to interact with it.
- If the browser crashes, call `tower_display_browser` again to relaunch it.
