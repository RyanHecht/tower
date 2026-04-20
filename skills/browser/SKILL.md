---
name: browser
description: >
  Browse the web using a real headed Chromium browser on a virtual desktop.
  Supports navigation, clicking, typing, screenshots, and full page interaction
  via Playwright. The user can watch the browser in real-time via noVNC.
---

# Browser Skill

You have access to a virtual desktop with a headed Chromium browser for web
browsing, automation, and interaction. This is a REAL browser (not headless),
which means it works with sites that detect and block headless browsers.

## Setup — REQUIRED before browsing

Before you can use any Playwright browser tools, you MUST call the
`launch_display` tool. This starts the virtual desktop (Xvfb + window
manager + VNC server) that the browser needs to render on.

```
1. Call `launch_display` (no arguments needed)
2. Wait for it to return — it gives you the display ID and noVNC URL
3. On your NEXT turn, Playwright browser tools become available
```

The `launch_display` tool is idempotent — calling it when a display is already
running just returns the existing display info.

## Available tools after launch

Once the display is running and you send your next message, these Playwright
tools become available (among others):

- `browser_navigate` — go to a URL
- `browser_click` — click an element (by text, accessibility label, or coordinates)
- `browser_type` — type text into a focused element
- `browser_snapshot` — get the accessibility tree of the current page
- `browser_screenshot` — take a screenshot (with `--caps=vision` enabled)
- `browser_tab_list` — list open tabs
- `browser_tab_create` — open a new tab
- `browser_go_back` / `browser_go_forward` — navigation history
- `browser_wait` — wait for a condition
- `browser_evaluate` — run JavaScript in the page

## Tips

- Prefer `browser_snapshot` (accessibility tree) over `browser_screenshot` for
  finding elements — it's faster and more reliable.
- Use `browser_screenshot` when you need to see what the page looks like
  visually (layout, images, visual bugs).
- The user can watch what you're doing in real-time by opening the noVNC URL
  returned by `launch_display`.
- The browser runs with `--no-sandbox` and `--disable-dev-shm-usage` flags
  for container compatibility.
- When done browsing, you can call `destroy_display` to free resources, but
  it's fine to leave the display running for future use in the session.

## Checking display status

Call `get_display` to check whether a virtual desktop is currently running
for this session.
