# Browser & Desktop Automation Tools for AI Agents

Research compiled for the Tower project — a containerized Copilot agent daemon with Xvfb + Chromium + noVNC.

---

## Executive Summary

There are **three tiers** of tools for giving AI agents browser/desktop control:

| Tier | Approach | Best For | Key Project |
|------|----------|----------|-------------|
| **1. Browser via DOM/Accessibility** | Controls browser through DevTools Protocol, accessibility tree | Structured web automation, fast, deterministic | **Playwright MCP** (31k★) |
| **2. Browser via Vision** | Takes screenshots, reasons about pixels, clicks coordinates | Visual-heavy pages, human-like browsing | **browser-use** (88k★) |
| **3. Full Desktop Control** | Screenshots + xdotool for mouse/keyboard on X11 | Non-browser apps, full desktop automation | **Anthropic Computer Use** (reference impl) |

**Recommendation for Tower:** Use **Playwright MCP** as the primary browser tool (fast, structured, deterministic) + a **computer-use MCP server** (xdotool/scrot-based) for full desktop fallback. Add `--caps=vision` to Playwright MCP for screenshot-based fallback when the accessibility tree isn't sufficient.

---

## 1. Browser Automation MCP Servers

### 1.1 Playwright MCP (Microsoft Official) ⭐ TOP PICK

| | |
|---|---|
| **Repo** | https://github.com/microsoft/playwright-mcp |
| **Stars** | 31,103 |
| **License** | Apache-2.0 |
| **Language** | TypeScript (npm: `@playwright/mcp`) |
| **Integration** | MCP server (stdio or HTTP/SSE) |
| **Maturity** | Very high — Microsoft-maintained, first-party |

**What it does:** Lets AI agents control a browser through Playwright. **Default mode** uses the accessibility tree (structured text) rather than screenshots — fast, token-efficient, deterministic. **Vision mode** (`--caps=vision`) adds screenshot-based coordinate interactions.

**Tools exposed (40+ tools):**

Core automation:
- `browser_navigate`, `browser_navigate_back` — URL navigation
- `browser_click`, `browser_type`, `browser_fill_form` — interaction
- `browser_hover`, `browser_drag`, `browser_select_option` — advanced interaction
- `browser_press_key` — keyboard
- `browser_snapshot` — accessibility tree capture (primary mode)
- `browser_take_screenshot` — pixel screenshot (vision mode)
- `browser_evaluate`, `browser_run_code` — JS execution
- `browser_wait_for` — waits
- `browser_file_upload`, `browser_handle_dialog` — file/dialog handling
- `browser_console_messages`, `browser_network_requests` — debugging
- `browser_resize` — viewport control
- `browser_tabs` — tab management

Opt-in capabilities (`--caps=`):
- `vision` — coordinate-based interactions using screenshots
- `pdf` — PDF generation
- `devtools` — element highlighting, tracing, video recording, locator picking
- `network` — request mocking/routing
- `storage` — cookie/localStorage/sessionStorage management

**Works with headed Chromium on X11/Xvfb: YES**
- Default is **headed** mode (not headless)
- Respects `DISPLAY` environment variable
- Config option: `--browser chrome`, `--executable-path /usr/bin/chromium`
- For our Xvfb setup: `export DISPLAY=:99 && npx @playwright/mcp@latest --browser chrome --executable-path /usr/bin/chromium-browser`
- Can run as standalone HTTP server: `--port 8931` (agent connects via URL)
- Docker note: their Docker image only supports headless, but we'd run it directly in our container

**Screenshots for vision models: YES**
- `browser_take_screenshot` returns PNG/JPEG
- With `--caps=vision`, the model can click at x,y coordinates based on screenshots
- Screenshots can be full-page or element-scoped

**Example config for Tower:**
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--browser", "chrome",
        "--executable-path", "/usr/bin/chromium-browser",
        "--caps", "vision,pdf,devtools",
        "--no-sandbox",
        "--viewport-size", "1024x768"
      ],
      "env": {
        "DISPLAY": ":99"
      }
    }
  }
}
```

---

### 1.2 Browserbase MCP Server (Stagehand)

| | |
|---|---|
| **Repo** | https://github.com/browserbase/mcp-server-browserbase |
| **Stars** | 3,275 |
| **License** | MIT |
| **Language** | TypeScript |
| **Integration** | MCP server (cloud-hosted or local) |
| **Maturity** | Good — backed by Browserbase (venture-funded) |

**What it does:** Natural-language browser automation using Stagehand AI framework. Intent-based — you say "click the login button" and it figures out the selector.

**Tools exposed:**
- `navigate` — go to URL
- `act` — perform action described in English
- `observe` — list actionable items on page
- `extract` — pull structured data
- `screenshot` — capture page
- `session_create`, `session_close` — manage sessions

**Works with headed Chromium on X11/Xvfb:** Primarily designed for **cloud-hosted** browsers (Browserbase's infra). Has a local mode but it's secondary. **Not ideal for our use case** — we want to control OUR local browser, not a remote one.

**Relevance to Tower:** Low-medium. The cloud-hosted model doesn't fit our architecture. The Stagehand framework itself (separate from the MCP server) could theoretically be used locally, but Playwright MCP is more mature and flexible for local headed browsers.

---

### 1.3 executeautomation/mcp-playwright (Community)

| | |
|---|---|
| **Repo** | https://github.com/executeautomation/mcp-playwright |
| **Stars** | 5,452 |
| **License** | MIT |
| **Language** | TypeScript |
| **Integration** | MCP server |
| **Maturity** | Moderate — community maintained |

**What it does:** Earlier community Playwright MCP server (predates Microsoft's official one). Similar capabilities but less polished.

**Relevance to Tower:** Superseded by Microsoft's official `@playwright/mcp`. Skip this.

---

### 1.4 Playwriter (Chrome Extension + MCP)

| | |
|---|---|
| **Repo** | https://github.com/remorses/playwriter |
| **Stars** | 3,387 |
| **License** | MIT |
| **Language** | HTML/TypeScript |
| **Integration** | Chrome extension + CLI/MCP |

**What it does:** Chrome extension that lets agents run Playwright code snippets in a stateful sandbox within an existing browser tab.

**Relevance to Tower:** Interesting concept but extension-based approach adds complexity. Playwright MCP is simpler.

---

## 2. Computer Use / Desktop Control

### 2.1 Anthropic Computer Use Tool (Reference Implementation) ⭐ KEY REFERENCE

| | |
|---|---|
| **Repo** | https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo |
| **Parent Repo Stars** | ~5,000+ |
| **License** | MIT |
| **Language** | Python |
| **Integration** | Anthropic API tool definition (not MCP) |
| **Maturity** | Beta — Anthropic reference implementation |

**What it does:** The canonical implementation of Anthropic's "computer use" capability. Runs inside Docker with Xvfb + tint2/Mutter window manager + noVNC. Claude sees screenshots, reasons about them, and sends back mouse/keyboard actions.

**How it works — the agent loop:**
1. Claude requests a screenshot
2. Your code captures the Xvfb display (via `scrot` or similar)
3. Screenshot sent to Claude as base64 PNG
4. Claude analyzes and returns an action: `mouse_move(x, y)`, `left_click(x, y)`, `type("text")`, `key("ctrl+c")`, `scroll(direction, amount)`
5. Your code executes via `xdotool`
6. Repeat

**API tool definition:**
```python
{
    "type": "computer_20251124",
    "name": "computer",
    "display_width_px": 1024,
    "display_height_px": 768,
    "display_number": 1,
}
```

**Architecture (matches Tower closely):**
```
Docker Container:
├── Xvfb (:1) — virtual display
├── Mutter/tint2 — window manager
├── noVNC (port 6080) — human viewing
├── VNC server (port 5900)
├── Chromium, apps, etc.
└── Python agent loop
    ├── Screenshot capture (scrot/xdotool)
    ├── xdotool for mouse/keyboard
    └── Anthropic API calls
```

**Works with X11/Xvfb: YES** — it's literally designed for this.

**Key insight for Tower:** This is the **exact same architecture** we're building. Their Docker container uses:
- `Xvfb :1 -screen 0 1024x768x24`
- `xdotool` for input
- `scrot` for screenshots
- VNC + noVNC for human viewing
- Recommended resolution: 1024x768 (XGA) for best model performance

**Important notes:**
- Works with Claude models only (it's an Anthropic-specific tool type)
- NOT an MCP server — it's a tool definition in the Anthropic API
- Can be wrapped in an MCP server (several projects do this, see below)

---

### 2.2 Computer Use MCP Servers (X11-based)

These wrap the xdotool/screenshot approach as MCP servers:

#### domdomegg/computer-use-mcp

| | |
|---|---|
| **Repo** | https://github.com/domdomegg/computer-use-mcp |
| **Stars** | ~100-200 (estimated) |
| **License** | MIT |
| **Language** | Python |
| **Integration** | MCP server |

Reference MCP server for desktop control. Uses xdotool + scrot. Works with Claude Desktop and Claude Code.

#### Dizzident/xvfb-computer-use-mcp ⭐ MOST RELEVANT PATTERN

| | |
|---|---|
| **Repo** | https://github.com/Dizzident/xvfb-computer-use-mcp |
| **Stars** | 1 |
| **License** | Unknown |
| **Language** | TypeScript |
| **Integration** | MCP server |

**Specifically designed for headless Xvfb automation.** Features:
- Parallel virtual desktops (each session gets unique X display)
- Fast screenshots via `ffmpeg x11grab`
- Full input via `xdotool`
- Window detection and process management
- Automatic cleanup
- Qt6 compatibility

**Dependencies:** Node.js 18+, xvfb, xdotool, ffmpeg, openbox

**Relevance to Tower:** Very high architectural relevance — this is purpose-built for our use case. However, very low stars/maturity. We'd likely want to build our own based on this pattern.

#### PegasisForever/computer-use

| | |
|---|---|
| **Repo** | https://github.com/PegasisForever/computer-use |
| **Language** | Rust |
| **Integration** | MCP server |

Linux/X11 computer use via xdotool, scrot, ffmpeg. Binary distribution. Features mouse, keyboard, screenshot, screen recording.

---

### 2.3 clawdcursor (Cross-Platform Desktop Automation)

| | |
|---|---|
| **Repo** | https://github.com/AmrDab/clawdcursor |
| **Stars** | 191 |
| **License** | Unknown |
| **Language** | TypeScript |
| **Integration** | MCP server |

OS-agnostic, model-agnostic desktop automation. Gives AI agents "eyes, hands, and ground-truth verification" on Windows, macOS, and Linux.

---

## 3. AI Browser Agents (SDK/Framework Level)

### 3.1 browser-use ⭐ MOST POPULAR

| | |
|---|---|
| **Repo** | https://github.com/browser-use/browser-use |
| **Stars** | 88,682 |
| **License** | MIT |
| **Language** | Python |
| **Integration** | Python SDK + MCP server mode |
| **Maturity** | Very high — massive community |

**What it does:** Python framework that connects AI models to a browser via Playwright. Model-agnostic (OpenAI, Claude, Gemini, etc.). The agent sees the page (via accessibility tree or screenshots), decides actions, and executes them.

**MCP server mode:**
```json
{
  "mcpServers": {
    "browser-use": {
      "command": "uvx",
      "args": ["browser-use[cli]", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Works with headed Chromium on X11/Xvfb:** Yes — uses Playwright under the hood, respects DISPLAY.

**Key differentiator:** The AI reasoning happens INSIDE browser-use (it manages the agent loop). With Playwright MCP, the reasoning happens in the calling agent (Copilot, Claude, etc.).

**Relevance to Tower:** High as a framework, but **overlaps with what Copilot already does** (Copilot + Playwright MCP achieves the same thing). Best used if we want a standalone browser agent subprocess, not as the primary tool for Copilot.

---

### 3.2 ByteDance UI-TARS Desktop

| | |
|---|---|
| **Repo** | https://github.com/bytedance/UI-TARS-desktop |
| **Stars** | 29,450 |
| **License** | Apache-2.0 |
| **Language** | TypeScript |

Multimodal AI agent stack — connects vision models to browser/desktop. Has its own MCP server. More of a competing architecture than a tool we'd integrate.

---

## 4. Copilot CLI's Built-in Browser Skill

### How it works:

Copilot CLI has a built-in `browser` skill that uses **Browserbase's cloud infrastructure**:

1. Agent invokes the browser skill
2. Browserbase spins up a **remote** cloud browser session
3. The skill provides tools: navigate, click, fill, screenshot, extract
4. All browsing happens on Browserbase's servers, not locally
5. Results come back as text/screenshots

### Limitations for Tower:
- **Cloud-only** — uses Browserbase's remote browsers, not our local Chromium
- **Not configurable** for a specific DISPLAY or Chrome path
- **Requires Browserbase API key** and network access
- The user can't "see" the browser in noVNC (it's remote)

### Conclusion:
The built-in browser skill is **not suitable** for Tower's architecture. We need local browser control via Playwright MCP instead.

---

## 5. Screenshot & Vision Integration

### How vision models work with desktop/browser:

1. **Screenshot capture:** Tool captures the display (via `scrot`, `xdotool`, Playwright's `screenshot()`, or `ffmpeg x11grab`)
2. **Base64 encoding:** Screenshot encoded as base64 PNG
3. **Model input:** Sent as an image in the model's message (works with GPT-4o, Claude with vision, Gemini)
4. **Model output:** Model reasons about the image and returns structured actions (click at x,y, type text, etc.)

### Resolution recommendations (from Anthropic):
- **Best:** 1024x768 (XGA) — optimal for model accuracy
- **Acceptable:** Up to 1920x1080, but model downscales internally
- **Tip:** Scale screenshots DOWN before sending to avoid wasted tokens and reduced accuracy

### Playwright MCP vision mode:
- Add `--caps=vision` to enable screenshot-based interactions
- `browser_take_screenshot` returns the image
- Model can then use `browser_click` with coordinates instead of element references
- Best of both worlds: use accessibility tree first, fall back to vision for complex UIs

### For full desktop screenshots:
- `scrot` — simple X11 screenshot utility
- `xdotool getactivewindow` + `import` (ImageMagick) — window-specific
- `ffmpeg -f x11grab` — fast, can grab specific regions
- All produce PNGs suitable for vision model input

---

## 6. Recommended Architecture for Tower

```
┌─────────────────────────────────────────────┐
│  Tower Container                            │
│                                             │
│  Xvfb :99 (1024x768x24)                    │
│  ├── openbox / fluxbox (window manager)     │
│  ├── Chromium (on DISPLAY=:99)              │
│  ├── x11vnc → noVNC (port 6080, for human)  │
│  │                                          │
│  ├── MCP: Playwright MCP Server             │
│  │   └── Controls Chromium via CDP          │
│  │   └── Accessibility tree + vision        │
│  │   └── 40+ browser automation tools       │
│  │                                          │
│  ├── MCP: Computer Use Server               │
│  │   └── xdotool (mouse/keyboard)           │
│  │   └── scrot/ffmpeg (screenshots)         │
│  │   └── For non-browser desktop apps       │
│  │                                          │
│  └── Copilot Agent (consumer of MCP tools)  │
│      └── Calls browser_* and computer_*     │
│      └── Vision model for screenshots       │
└─────────────────────────────────────────────┘
```

### Two MCP servers, complementary roles:

| | Playwright MCP | Computer Use MCP |
|---|---|---|
| **Controls** | Browser only (via CDP) | Entire X11 desktop |
| **Input method** | DOM/accessibility tree | xdotool (raw mouse/keyboard) |
| **Screenshot** | Browser viewport only | Full display |
| **Speed** | Fast (structured data) | Slower (vision loop) |
| **Reliability** | High (deterministic) | Medium (vision-dependent) |
| **Use for** | Web browsing, forms, scraping | Desktop apps, file managers, terminals |

---

## 7. Comparison Matrix

| Project | Stars | License | Type | Local X11 | Screenshots | MCP | Recommended |
|---------|-------|---------|------|-----------|-------------|-----|-------------|
| **Playwright MCP** | 31k | Apache-2.0 | Browser automation | ✅ | ✅ (vision cap) | ✅ | ✅ **Primary** |
| **browser-use** | 88k | MIT | AI browser framework | ✅ | ✅ | ✅ | ⚠️ Overlaps w/ Copilot |
| **Anthropic Computer Use** | ~5k | MIT | Desktop reference impl | ✅ | ✅ | ❌ (API tool) | ✅ **Reference** |
| **Browserbase MCP** | 3.2k | MIT | Cloud browser | ❌ (cloud) | ✅ | ✅ | ❌ Wrong model |
| **mcp-playwright (community)** | 5.4k | MIT | Browser automation | ✅ | ✅ | ✅ | ❌ Superseded |
| **xvfb-computer-use-mcp** | 1 | ? | Desktop/Xvfb | ✅ | ✅ | ✅ | ⚠️ Too immature |
| **clawdcursor** | 191 | ? | Desktop cross-platform | ✅ | ✅ | ✅ | ⚠️ Worth watching |
| **UI-TARS Desktop** | 29k | Apache-2.0 | Full agent stack | ✅ | ✅ | ✅ | ❌ Competing arch |
| **Playwriter** | 3.3k | MIT | Chrome ext + MCP | ✅ | ✅ | ✅ | ❌ Extension-based |

---

## 8. Action Items

1. **Add Playwright MCP** to Tower's MCP config — this is the primary browser tool
   - Configure with `--browser chrome`, `--executable-path`, `--caps=vision,pdf,devtools`, `--no-sandbox`
   - Set `DISPLAY=:99` env var

2. **Build a lightweight computer-use MCP server** for desktop control
   - Use xdotool + scrot/ffmpeg
   - Tools: `screenshot`, `mouse_click(x,y)`, `mouse_move(x,y)`, `type_text(text)`, `press_key(key)`, `scroll(direction)`
   - Reference: Anthropic's computer-use-demo and xvfb-computer-use-mcp

3. **Don't use** the built-in Copilot browser skill — it's cloud-based Browserbase, not local

4. **Set Xvfb resolution** to 1024x768 — Anthropic's recommended size for vision model accuracy

5. **Consider browser-use** as an optional Python subprocess for complex agentic web tasks
