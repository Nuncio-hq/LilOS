**Verdict: PASS**

## Question
Can the harness own a browser (Playwright Chromium) and PTY terminals that an
agent drives through MCP/CLI while the Workbench shows them live and lets Oscar
take over, even when the window was closed?

**Yes.** All four properties demonstrated on one macOS VM:
1. Agent drives browser + terminal through real MCP stdio tools.
2. Workbench viewer streams both live (~60 fps) and shows every tool call.
3. A human clicks/types in the same page and shell — takeover works.
4. Closing the viewer does not stop the harness; reopening replays state
   instantly (verified with an agent click executed while zero viewers).

## Method
Throwaway harness on branch `spike/24-harness-browser-terminal` under
`spikes/24-harness/` (Node + Playwright + node-pty + ws + xterm.js +
@modelcontextprotocol/sdk). Harness serves the viewer at
`http://localhost:7240`, a REST tool API, and a `/ws` channel carrying JPEG
screencast frames + terminal bytes + input events. `src/mcp-server.mjs` is the
MCP surface; `src/agent-demo.mjs` is a scripted MCP client used as the agent.

## Evidence
- **Recording:** `spikes/24-harness/assets/recording.mp4` — agent opens the
  demo page, clicks, types, builds+serves a site in the terminal, opens the
  discovered preview; then human clicks Bump and runs a shell command; then the
  tab is closed, an agent click + command still run, and the reopened viewer
  shows the updated page and full terminal backlog.
- **Latency** (`node src/measure.mjs` → `results/latency.json`, 12 s,
  1361 frames, glass-to-glass timestamp decoded from page pixels):
  e2e visual p50 34 ms / p95 64 ms / max 71 ms — well under the 200 ms bar.
  Transport age p50 0 / p95 1 ms. Viewer click→pixel p50 50 / p95 83 ms.
- **Preview discovery** (`node src/preview-test.mjs` →
  `results/preview-discovery.json`): PTY output scan found the dev-server URL
  in 82–166 ms; explicit `PREVIEW:` marker in 6–15 ms; `lsof` port polling took
  ~410 ms and missed a silent server entirely. **Recommendation: output
  scanning + `PREVIEW:` override; drop port detection.**
- Agent demo transcript (all tool calls ok):

```
[agent] connected to lilos-harness MCP server
[agent] tool call → browser_open   ← {"ok":true,...,"title":"Harness demo page"}
[agent] tool call → browser_click  ← {"ok":true,"via":"selector","selector":"#bump"}  (x2)
[agent] tool call → browser_type   ← {"ok":true,"typed":26}
[agent] tool call → browser_read   ← {"url":".../demo","text":"...page 2..."}
[agent] tool call → terminal_run   ← {"output":"built","exitCode":0}
[agent] tool call → terminal_write ← {"ok":true}   (python3 -m http.server 8911 &)
[agent] tool call → previews_list  ← {"previews":[{"url":"http://localhost:8911","via":"scan"}]}
[agent] tool call → browser_open   ← {"ok":true,"url":"http://localhost:8911/"}
[agent] tool call → terminal_run   ← {"output":"agent done\nDarwin","exitCode":0}
```

- Gotchas documented in `NOTES.md`: screencast is damage-driven (rAF paints ≈
  60 fps, setInterval ≈ 0.4 fps — fine for real pages; ack every frame);
  screencast stops when no viewers (state/tools unaffected); terminal.run uses
  begin/end markers; node-pty spawn-helper needed +x on macOS.

## CDP screencast vs Electron `<webview>` attach
CDP screencast works headless, engine-agnostic, multi-viewer, and already meets
latency. `<webview>` gives a crisper native picture only while the app window
is open — exactly the case that fails the spike question. **Ship screencast as
the universal path; Electron webview is optional polish later.**

## What the real slice (#36) must implement
See `spikes/24-harness/NOTES.md` §"What the real slice must implement":
harness service (Bun entry point OK), MCP tool surface (browser open/click/
type/read/scroll/eval + terminal run/write/read + previews.list), Workbench
viewer with snapshot-then-live reconnect and multi-viewer fan-out, PTY URL
scanner + `PREVIEW:` protocol, PTY respawn + screencast on/off lifecycle,
plus hardening (auth, address bar, resize, multi-session).

Posted as a file because this session has no GitHub API auth — see Status.
