# Spike #23 — attach LilOS's MCP server to a Hermes session

**Verdict: PASS (via ACP)** — `session/new { mcpServers }` attaches a LilOS MCP
server to one Hermes session only, verified end-to-end on live `hermes serve`
+ ACP against a real turn loop. WS `session.create` has **no** per-session MCP
surface (extra=forbid); only profile-wide `mcp_servers` config exists there.

> Live engine caveat: `openai-codex` on this VM is signed out and the
> OpenRouter key returns `HTTP 401 User not found` → `LIVE_ENGINE_UNAVAILABLE`
> for the real LLM. All runs below use the real `hermes serve` process +
> real ACP/WS protocols against a local OpenAI-compatible stub (a named
> `providers:` entry → `http://127.0.0.1:8377/v1`). The stub makes the model
> deterministic (it calls `mcp__lilos__terminal_run` when the tool is
> offered); every Hermes-side mechanism (session registry, MCP registration,
> toolset expansion, tool dispatch, WS events) is unmodified production code.

## The question

How does `engine-hermes` give a Hermes session LilOS's MCP server (browser,
terminal, app ops) without LilOS depending on a Hermes-only feature?

## Method (in issue order)

| Try | Surface | Result |
|---|---|---|
| (a) per-profile `mcp_servers` written by harness | `config.yaml` under `HERMES_HOME` of a profile | Works, but **profile-wide**: every session of that profile gets the tools. See `evidence/mcp_calls_ws.jsonl` — both WS sessions of `spike23` called `mcp__lilos__terminal_run` through one server process (pid 6209). |
| (b) WS-side per-session option | `session.create` params | **Does not exist.** `SessionCreateParams` (`tui_gateway/contracts/sessions.py`) extends `ProfileParams` (`extra=forbid`) with no `mcp_servers`; live call returns `4000: mcp_servers: Extra inputs are not permitted`. `_load_enabled_toolsets` merges *all* enabled profile MCP servers. |
| (c) upstream patch `session.create { mcp_servers }` | `patches/0001-session-create-mcp_servers.patch` | Drafted (not opened). Mirrors the ACP path: stash server list on the session record, `register_mcp_servers` + `mcp-<name>` toolset expansion at agent build. |
| **ACP path** (the answer) | `session/new { mcpServers }` | **PASS.** `acp_adapter/server.py::_register_session_mcp_servers` registers the stdio server into the session's profile scope at runtime (no config write); `_expand_acp_enabled_toolsets` adds `mcp-lilos` to *that agent's* toolsets only. |

## Evidence (ACP path)

Harness: `acp_probe.py` spawns `hermes acp` over stdio (real ACP client SDK),
one process, profile `spike23` (Hermes home `~/.hermes/profiles/spike23`).

- **S1** `new_session { mcpServers:[{name:"lilos", command:…/python3, args:[lilos_mcp_server.py], env:{LILOS_MCP_LOG:…}}] }` + prompt
  → wire log `evidence/wire_acp.jsonl` seq 7–9: `tools_count=38` incl. all 6
  `mcp__lilos__*` tools → stub issued tool_call → Hermes dispatched to the
  server → `evidence/mcp_calls.jsonl` `{"tool":"terminal_run",
  "nonce":"ad4f50f68435"}` → agent's final text echoed
  `LILOS_MCP_OBSERVED nonce=ad4f50f68435`.
- **S2** (same process/profile) `new_session { mcpServers:[] }` + prompt
  → wire seq 10–11: `tools_count=32`, `lilos_tools=[]`, zero calls to the
  lilos server. **Session isolation confirmed.**

WS control run (`ws_probe.py`, `hermes serve` on :9119, real gateway
protocol `hermes-gateway-v1`): sessions W1/W2 of profile `spike23` BOTH got
all 6 tools and BOTH made calls (seq 12–16, `tools_count=42`) — proving
method (a) is profile-wide, not session-scoped.

## Tool-schema token cost per turn

Method: the stub logs `tools_bytes` (serialized `tools` JSON array) on every
`/v1/chat/completions` request, plus a full schema dump
(`evidence/tools_dump_lilos.json` — extracted via the same
`get_tool_definitions()` Hermes calls).

| Surface | tools bytes (with lilos) | (without) | delta |
|---|---|---|---|
| ACP session | 50 118 | 47 745 | **2 373 B** |
| WS session | 61 552 | — (profile-wide) | — |

Compact dump of the 6 `mcp__lilos__*` schemas alone: **2 247 B**.
Tokens ≈ bytes/4 (Hermes' own `CHARS_PER_TOKEN=4` estimator): **≈ 590
tokens/request** added to every turn of the session (~0.3 % of a 200k
context). With `tools.tool_search.enabled: "auto"` (Hermes default) all
`mcp-*` tools are deferred behind the `tool_search`/`tool_batch` bridge —
near-zero per-turn cost, but the model must search before calling; the spike
profile pinned it `off` to keep the wire observable.

## What the real `engine-hermes` slice must implement

1. **Speak ACP `session/new`, not WS `session.create`, for sessions that own
   LilOS tools.** Pass `mcpServers: [lilos_stdio_entry]` — one Hermes-only
   adapter detail stays on our side: Hermes already implements the ACP field,
   so LilOS only depends on standard ACP. `engine-fake` already accepts the
   same field per #6.
2. Wire `browser`/`terminal`/`app ops` LilOS tools as one stdio MCP server
   per LilOS company host (local dev: `bun run apps/harness` child or the
   deployed relay). Keep `trust: untrusted` semantics in mind for
   write-capable tools (per-profile approval record in Hermes).
3. If the desktop/WS surface is ever required: the drafted patch in
   `patches/` is the upstream ask (session-scoped `mcp_servers` on
   `session.create`); until then the WS path can only offer profile-wide
   wiring — which would leak LilOS tools into every session of that profile.
   A fallback is one dedicated Hermes profile per LilOS company
   (profiles are isolation islands by design) — acceptable because LilOS
   sessions are long-lived per thread, not per profile.
4. Token budget: ~0.6 k tokens/turn for a 6-tool server is negligible; plan
   tool_search-compatible descriptions anyway for the deferred-tools path.

## Files

- `lilos_mcp_server.py` — 6-tool stdio JSON-RPC MCP server (pure stdlib;
  tools: `browser_navigate`, `browser_snapshot`, `terminal_run`,
  `app_launch`, `file_stage`, `notify`; logs every call + nonce to
  `$LILOS_MCP_LOG`).
- `acp_probe.py` — ACP client driving `hermes acp` (S1 with / S2 without
  `mcpServers`).
- `ws_probe.py` — WS gateway client (`session.create` + `prompt.submit`,
  approval auto-answer).
- `openai_stub.py` — deterministic OpenAI-compatible backend (chat +
  SSE streaming, wire logger).
- `patches/0001-session-create-mcp_servers.patch` — upstream proposal (c).
- `evidence/` — wire logs, MCP call logs, schema dumps, serve logs.
- Profile used: `~/.hermes/profiles/spike23/config.yaml` (named provider
  `spike-stub` → stub; `tools.tool_search.enabled: "off"`; `mcp_servers`
  added only for the WS/profile-wide leg).
