# Spike #24 — harness-owned browser + terminal, live in the Workbench

**Verdict: PASS.** A single harness process can own a headless Chromium and a
PTY shell, let an agent drive both through MCP tools, and stream both live to a
web viewer where a human can click and type — all inside the latency budget
(<200 ms/frame on localhost) and with state surviving a closed viewer window.

Run it: `cd spikes/24-harness && npm install && node src/harness.mjs`, open
http://localhost:7240, then `node src/agent-demo.mjs` (scripted MCP client).

## Architecture (what was built)

```
                 MCP stdio                     WS /ws (frames, term, input)
  agent ──► src/mcp-server.mjs ──HTTP /api/*──► src/harness.mjs ◄── viewer/index.html
                  (thin proxy)                  │  ├─ Playwright Chromium (headless)
                                                │  │    Page.startScreencast jpeg
                                                │  │    Input.dispatchMouseEvent/insertText
                                                │  └─ node-pty /bin/zsh (110x28)
                                                └─ http server: viewer + /demo + /api
```

- `src/harness.mjs` — one Node process, ~340 lines. Owns the browser page and
  the shell; exposes a tool REST API (`/api/browser.open`, `...click`,
  `...type`, `...read`, `...scroll`, `...eval`, `terminal.run`, `terminal.write`,
  `terminal.read`, `previews.list`, `state`) and a viewer WebSocket.
- `src/mcp-server.mjs` — MCP stdio server (@modelcontextprotocol/sdk) that
  proxies each tool to the harness REST API. This is the seam a real engine
  attaches to; the harness does not care which engine calls.
- `src/agent-demo.mjs` — a real MCP `Client` over stdio that drives the tools
  (open demo → click #bump → type → terminal build+serve a site → open the
  discovered preview). Used for the recording; a scripted MCP client stands in
  for a live engine.
- `viewer/` — Workbench-style page: canvas paints JPEG screencast frames and
  forwards mouse/keyboard to CDP; xterm.js renders the shared PTY and forwards
  keystrokes to `pty.write`; an activity feed shows every agent tool call.
  WebSocket auto-reconnects.

## Numbers (localhost, M-series macOS, 12 s run — `node src/measure.mjs`)

| metric | p50 | p95 | max |
|---|---|---|---|
| end-to-end visual latency (page pixel → viewer canvas) | 34 ms | 64 ms | 71 ms |
| harness→viewer WS transport age | 0 ms | 1 ms | 2 ms |
| input → pixel (viewer click lands in page) | 50 ms | 83 ms | 83 ms |
| frame gap (effective fps) | 17 ms (~60 fps) | 25 ms | — |

End-to-end latency is measured by decoding a timestamp encoded in the page's
pixels (a 14-cell clock bar) at the viewer — i.e. true glass-to-glass, not just
transport. Verdict criterion (<200 ms) is met with ~3x headroom.

Commands: `bun run harness` (or `node src/harness.mjs`), `node src/measure.mjs`
→ `results/latency.json`.

## Findings that matter for the real slice

1. **`Page.startScreencast` is damage-driven.** On Playwright headless Chromium
   (both `headless_shell` and `channel:'chromium'`), frames only flow when the
   page repaints. A `requestAnimationFrame` loop yields ~60 fps; a
   `setInterval`-driven style change yields ~2 frames/5 s. For real apps this is
   fine (pages repaint on activity), but the Workbench must not assume a fixed
   frame rate — show "last frame age", and consider `Page.captureScreenshot`
   polling or `--enable-begin-frame-control` if we ever need guaranteed cadence
   on an idle page. Also: **ack every frame**
   (`Page.screencastFrameAck(sessionId)`) or Chrome stops sending after a few.
2. **Cast only while watched.** The harness runs `startScreencast` when the
   first viewer connects and `stopScreencast` when the last leaves; with zero
   viewers the browser still runs and agents still act (verified: a tool call
   landed while the viewer tab was closed). The Workbench being closed must be
   free — this design keeps it so.
3. **Reconnect = snapshot + live.** On WS connect the harness replays the last
   JPEG frame + a bounded terminal scrollback (400 KB ring) + current page URL /
   preview list. Closing and reopening the window is instant and lossless.
4. **Terminal command capture needs markers.** PTY output is a byte stream; to
   return command output to `terminal.run` callers the harness wraps commands
   with unique begin/end markers and takes the *last* match (the shell echoes
   the command, so markers appear twice). `terminal.write` stays raw for
   interactive programs (servers, REPLs). node-pty on macOS needed
   `chmod +x prebuilds/darwin-arm64/spawn-helper` after npm install — a real
   install path must handle that (postinstall or `bun install` native build).
5. **Two input paths exist, and both are needed.** Selector-based actions
   (`page.click('#bump')`, `page.fill`) are what agents should use (robust).
   Coordinate-based `Input.dispatchMouseEvent` + `Input.insertText` is what the
   viewer needs (a human clicks pixels). They interoperate on the same page —
   verified on camera (`assets/recording.mp4`).

## Preview URL discovery — recommendation

Measured in `src/preview-test.mjs` (`results/preview-discovery.json`):

| method | result |
|---|---|
| PTY output scan (`http://localhost:PORT` regex on PTY bytes) | detected python http.server's printed URL in 82–166 ms; **zero protocol cost** — works for `npm run dev`, `python -m http.server`, anything that prints its URL |
| explicit `PREVIEW: <url>` marker in output | 6–15 ms; works even when the dev server prints nothing; also carries paths (`/my-preview`) |
| port detection (`lsof -iTCP -sTCP:LISTEN` polling) | ~410 ms per detect; **missed a server that prints no URL entirely** (28 tries, timeout); finds a port but not the app/path/URL the user should open |

**Recommendation: scan PTY output first, `PREVIEW:` marker as the explicit
override, no port polling.** Scanning alone caught the real dev-server URL in
<200 ms. The marker is the escape hatch for silent servers and non-root paths.
Port detection gives you a bare port with no URL semantics (which app? which
path? http or https?) — and it missed the silent case outright. Keep the scanner
in the harness (it sees all terminal output anyway); agents never have to do
anything.

## CDP screencast vs Electron `<webview>` attach (for #36)

This spike used the pure-CDP route (no Electron), which is also the
engine-agnostic path:

- **CDP screencast** (measured here): works headless, engine-agnostic, same code
  path whether the Workbench is an Electron window or a plain browser tab; one
  JPEG stream → any number of viewers; input is `Input.dispatch*` (already
  proven). Cost: encode+decode overhead (~34 ms e2e) and no GPU/DOM access in
  the viewer.
- **Electron `<webview>`/attach alternative**: when the Workbench is the
  Electron app, a `<webview>` tag hosts the real Chromium instance natively —
  zero-encode video, crisper, and input is native. But it only helps while the
  app window is open; an agent that must keep working when Oscar closes the
  window still needs the headless+screencast path, and debugging a detached
  webContents (`debugger.attach` + `sendInputEvent`) is strictly more machinery
  for the worst case. A hidden `BrowserWindow` can keep a native page alive, but
  that re-implements what headless Chromium already is.

**Recommendation: ship the CDP-screencast harness (this spike) as the universal
path; treat a future Electron `<webview>` "fast path" as optional polish, not
the foundation.** The screencast path already meets the latency budget.

## What the real slice (#36) must implement

1. Harness service (Bun entry point is fine — this spike used Node; nothing
   here is runtime-specific except node-pty, where Bun needs `bun:pty` or a
   node-pty-compatible binding) owning: Playwright Chromium page(s), PTY
   session(s), WS fan-out, tool REST/MCP surface. Feature-folder layout per
   AGENTS.md; boundary types in `packages/contracts` (frame msg, input msg,
   preview event, tool schemas).
2. MCP tool surface at least: `browser.open/click/type/read/scroll/eval`,
   `terminal.run/write/read`, `previews.list`. Keep the marker-based
   `terminal.run` capture.
3. Viewer (Workbench surface): canvas + input forwarding + xterm.js terminal +
   activity feed; snapshot-then-live reconnect; multiple viewers share the same
   session (already works — `viewers` is a Set).
4. Preview discovery: PTY URL scanner + `PREVIEW:` marker protocol documented
   for engines; drop port polling.
5. Lifecycle: PTY respawn on exit (verified needed — `exit` kills the shell);
   screencast on/off with viewer count; clean shutdown ordering.
6. Hardening beyond spike scope: auth on the WS/API (localhost-only is fine for
   spike), screencast quality/everyNthFrame tuning, page navigation UI (the
   owned browser has no address bar — the demo had to eval `location.href`),
   terminal resize events (`pty.resize` on xterm fit), multi-page/multi-terminal
   sessions, and macOS notarization concerns if bundled into the signed app.

## Evidence

- `assets/recording.mp4` — MCP agent drives browser+terminal live; human
  takeover; viewer close/reopen with state intact (annotated).
- `assets/agent-drove.png` — end state: agent-built preview site in the owned
  browser, its commands in the shared terminal, every tool call in the feed.
- `assets/state-restored.png` — viewer reopened: counter shows the click that
  ran while the window was closed; terminal backlog replayed.
- `results/latency.json`, `results/preview-discovery.json` — measured numbers.
- `src/agent-demo.mjs` stdout — all tool calls returned ok (see log in the
  verdict comment on the issue).
