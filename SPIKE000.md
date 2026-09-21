# SPIKE000 — custom UI driving one full Hermes turn over `/api/ws`

**Verdict: PASS** (all six pre-declared criteria; 2026-09-21, macOS, Hermes
v0.21.3). Question: can a bare client — exactly what a future Vite/React
CompanyOS app will be — control a full agent turn over the desktop app's own
JSON-RPC seam, with no middleware backend?

Backend: `HERMES_DASHBOARD_SESSION_TOKEN=<fixed> hermes serve --host 127.0.0.1
--port 9119` (headless backend; the same process the official Desktop app
spawns).

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Connect `ws://127.0.0.1:9119/api/ws?token=…`, receive `gateway.ready` | PASS |
| 2 | `client.capabilities {server_requests:true}` → method list (approval, clarify, sudo, secret, vault.*, preview.*, terminal.read, window.read, tour) | PASS |
| 3 | `session.create` returns session id | PASS (session `0ed7651b`) |
| 4 | `prompt.submit` accepted | PASS |
| 5 | Stream `message.delta` with non-empty text | PASS (3 deltas, `payload.text`="SPIKE0"…) |
| 6 | `message.complete` settles turn | PASS (`"SPIKE000-OK"`, usage block, model qwen3.8-flash-next, 18420+25 tokens) |

Full turn wall-clock: **3.7 s**, zero middleware.

Follow-up probe: same client with browser-style `Origin: http://localhost:5173`
(a Vite dev server origin) on the loopback bind — also **PASS**. So slice 1
needs no dev proxy.

Findings:
- Loopback ungate: `?token=` must match the server's session token; set
  `HERMES_DASHBOARD_SESSION_TOKEN` in the environment when starting `hermes
  serve` or the token is random per boot.
- Origin guard: origin host must be an accepted host for the bind
  (`localhost`/`127.0.0.1` for loopback); a foreign Origin → pre-accept close
  (HTTP 403 on handshake).
- DB rows are minted lazily on first prompt — abandoned draft sessions never
  litter history; useful renderer invariant.
- Server→client requests (approval/clarify/…) must be answered or refused
  (-32601) or the agent stalls to timeout.

Repro: start serve as above, then
`SPIKE_TOKEN=<token> ~/.hermes/hermes-agent/venv/bin/python spike000_ws_client.py`
