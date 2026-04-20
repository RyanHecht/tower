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

Call the `launch_display` tool (no arguments). This starts the virtual
desktop that the browser renders on. It returns a noVNC URL the user can
open to watch.

### Step 2: Launch Chromium

Use bash to launch Chromium on the display. The binary is `/usr/bin/chromium`.
Always use `DISPLAY=:N` (the display number from step 1) and these flags:

```bash
DISPLAY=:10 nohup chromium --no-sandbox --disable-dev-shm-usage \
  --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tower/data/chromium-profiles/SESSION_ID \
  "https://example.com" > /tmp/chromium.log 2>&1 &
disown $!
```

Key points:
- Use `nohup` + `disown` so the browser outlives the shell.
- Always include `--remote-debugging-port=9222` — this enables CDP
  (Chrome DevTools Protocol) which you'll use for screenshots and control.
- The `--user-data-dir` is provided in the `launch_display` result.
  It points to a per-session profile that persists logins, cookies, and
  browser state across container restarts. Use the exact path from the
  tool result — do NOT omit it.
- The binary is `chromium` (NOT `chromium-browser` or `google-chrome`).
- dbus errors in the log are harmless — ignore them.

### Step 3: Interact with the page

Use the CDP remote debugging port to control the browser:

**List open tabs:**
```bash
curl -s http://localhost:9222/json/list
```

**Take a screenshot** (via bash — the simplest approach):
```bash
DISPLAY=:10 scrot /tmp/screenshot.png
```
Then use the `view` tool to look at `/tmp/screenshot.png`.

**Take a screenshot via CDP** (when scrot doesn't capture what you need):
```python
python3 -c "
import urllib.request, json, base64, socket, hashlib, struct, os

data = json.loads(urllib.request.urlopen('http://localhost:9222/json/list').read())
ws_url = data[0]['webSocketDebuggerUrl']

# Parse WebSocket URL
parts = ws_url.replace('ws://', '').split('/', 1)
host_port = parts[0].split(':')
host, port = host_port[0], int(host_port[1])
path = '/' + parts[1] if len(parts) > 1 else '/'

# WebSocket handshake
key = base64.b64encode(os.urandom(16)).decode()
sock = socket.create_connection((host, port))
sock.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())

# Read handshake response
resp = b''
while b'\r\n\r\n' not in resp:
    resp += sock.recv(4096)

# Send Page.captureScreenshot
msg = json.dumps({'id': 1, 'method': 'Page.captureScreenshot', 'params': {'format': 'png'}}).encode()
frame = bytearray([0x81])
mask_key = os.urandom(4)
length = len(msg)
if length < 126:
    frame.append(0x80 | length)
else:
    frame.append(0x80 | 126)
    frame.extend(struct.pack('>H', length))
frame.extend(mask_key)
frame.extend(bytes(b ^ mask_key[i % 4] for i, b in enumerate(msg)))
sock.sendall(frame)

# Read response
data_buf = b''
while True:
    data_buf += sock.recv(65536)
    try:
        # Find JSON in response (skip WebSocket framing)
        start = data_buf.index(b'{\"id\":1')
        result = json.loads(data_buf[start:])
        break
    except (ValueError, json.JSONDecodeError):
        continue

img_data = base64.b64decode(result['result']['data'])
with open('/tmp/screenshot.png', 'wb') as f:
    f.write(img_data)
print(f'Saved screenshot: {len(img_data)} bytes')
sock.close()
"
```

**Navigate to a URL via CDP:**
```bash
curl -s http://localhost:9222/json/list | python3 -c "
import sys, json, urllib.request
tabs = json.load(sys.stdin)
tab_id = tabs[0]['id']
urllib.request.urlopen(f'http://localhost:9222/json/navigate/{tab_id}?url=https://example.com')
print('Navigated')
"
```

## Available tools

- `launch_display` — start the virtual desktop (MUST call first)
- `get_display` — check if a display is running
- `destroy_display` — shut down the display
- `scrot` — screenshot tool (via bash: `DISPLAY=:N scrot /tmp/shot.png`)
- `xdotool` — X11 automation (via bash: `DISPLAY=:N xdotool key Return`)

## Tips

- The user can watch what you're doing in real-time by opening the noVNC
  URL returned by `launch_display`.
- Use `scrot` for quick screenshots. Use CDP for precise page screenshots.
- Use `xdotool` for keyboard/mouse input outside of CDP.
- Always check if the browser is running with `ps aux | grep chromium`
  before trying to interact with it.
- If the browser crashes, just relaunch it with the same command.
