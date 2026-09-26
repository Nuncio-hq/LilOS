# Spike #22 — Hermes turn across Mac sleep/wake

**Question:** when the Mac sleeps mid-turn, how does `hermes serve` behave on wake,
and does an idle-sleep assertion held by the harness prevent idle sleep during a turn?

## Verdict (VM run) — **INCONCLUSIVE for real hardware, PASS for behavior model**

This VM cannot sleep (`sudo pmset sleepnow` → `Unable to sleep system: error 0xe00002e2`;
`pmset -g` shows `sleep 0` — powerd itself holds `PreventUserIdleSystemSleep` on the VM),
and no live LLM credentials exist here (`openai-codex` signed out; the configured
OpenRouter key returns HTTP 401). Per the orchestrator brief, the freeze legs below are
**SIGSTOP/SIGCONT simulations** of sleep — process pause + wall-clock jump, which is what
sleep looks like to a process — plus a stub OpenAI-compatible provider standing in for
the model link. The exact real-hardware rerun is scripted in `run_on_real_mac.sh`.

What the legs DO prove deterministically (all events timestamped in `transcripts/`):

### Leg A — freeze mid-`sleep` tool, client does NOT reattach
`transcripts/legA_freeze_no_reattach.jsonl`

- `tool.start` → 71.8s transcript gap (60s freeze) → probe wakes, heartbeat deadline
  (45s idle) → reconnect → `gateway.ready` → `session.events.since` → `{events:[],
  latest_seq:8}` — the turn was still running server-side.
- **+20s after the ws detach: `session.reclaimed {reason:"ws_orphan_reap"}`** — the
  server interrupted the orphaned turn and destroyed the session.
- Server log: the turn actually *completed* during the detach window
  (`status=complete duration=74.9s`) — but no client ever saw the completion;
  `session.activate` on the reaped id → error `4001 session not found`
  (server log: "detached/reaped runtime; client should resume the stored session").
- `session.resume` on the stored id resurrects the transcript
  (`resumed: <stored_id>`, `message_count:4`) — nothing is lost on disk.

### Leg A2 — same freeze, client DOES reattach (`session.activate`)
`transcripts/legA2_freeze_reattach.jsonl`

- Same freeze. On resume the probe reconnects, calls `session.events.since` then
  **`session.activate`** → reap countdown cancelled → `tool.complete` (duration 73s,
  frozen time included) and `message.complete` arrive live.
- **The turn survives sleep iff the client reattaches within
  `ws_orphan_reap_grace_s` (default 20s, env `HERMES_TUI_WS_ORPHAN_REAP_GRACE_S`,
  `0` = never reap) of the ws detach.**

### Leg B — freeze + provider link severed (stub killed while frozen)
`transcripts/legB_freeze_provider_killed.jsonl`

- On resume the provider socket is dead → `thinking.delta "⏳ waiting on provider —
  retrying in Ns (attempt n/3)"` → after 3 API attempts:
  `status.update {kind:lifecycle, "Provider temporarily unavailable — retrying
  automatically in Ns (cycle c/5)"}` → cycles back off 18s→31s→66s→62s→63s →
  on exhaustion the turn ends with `message.complete` `status=error`
  (same terminal shape as the EmptyStreamError run below). **Never hangs, never silent.**

### Leg C — idle-sleep assertion (caffeinate)
`transcripts/legC_pmset_assertions.txt`

- `caffeinate -i -t 120` registers `PreventUserIdleSystemSleep` owned by
  `pid (caffeinate)`; `pmset -g` reports `sleep 0 (sleep prevented by caffeinate, powerd)`.
- On exit the assertion disappears and only powerd's remains. On a real Mac
  (where `sleep` isn't already pinned to 0) this is exactly the mechanism that
  gates idle sleep while a turn runs.

### Bonus behavior observed (pre-spike baseline failure)
`transcripts/baseline.jsonl` and the first stub run: a provider returning a
malformed/empty stream produces `status.update` retry events then
`message.complete` with `status=error` — same terminal surface as the
severed-link path.

## The deterministic "interrupted" detection rule

On `hermes serve`'s `/api/ws`, a turn interrupted by sleep is **always detectable**
if the harness does the reconnect dance the official client already specifies
(`apps/shared/src/json-rpc-gateway.ts`):

1. Heartbeat: `gateway.ping` every 15s; if no inbound frame for 45s → declare the
   conn dead, reconnect, wait `gateway.ready`, send `client.capabilities`.
2. For each in-flight turn's `session_id`:
   a. `session.events.since {session_id, last_seen}` — replay missed events; if
      `truncated` or `epoch` changed, treat unseen range as unknown.
   b. **`session.activate {session_id}` (or `session.resume {stored_id}`) —
      within ~20s of the detach.** Success ⇒ turn continues; watch events.
   c. `session.activate` error `4001 session not found` OR a `session.reclaimed`
      event ⇒ the turn was interrupted server-side ⇒
      `session.resume {stored_id}` to reload the transcript, then surface
      **"interrupted by sleep — Retry"** (never a hanging spinner).
   d. `status.update`/`thinking.delta` retry events + eventual `message.complete`
      with `status=error` ⇒ provider link died ⇒ surface the error honestly.
3. Optional: keep-awake = `caffeinate -i` (IOPMAssertion) held only while
   `running=true`; on `message.complete`/`interrupted` release it.

A turn watchdog is **not** needed for correctness — the protocol already surfaces
every outcome — but a 20s "reattach deadline" timer is needed so a slow reconnect
doesn't silently lose the session to `ws_orphan_reap`.

## What the real slice must implement

- Reconnect on heartbeat deadline → `events.since` → `session.activate` per open
  turn, all inside 20s of wake (the orphan grace).
- On 4001/`session.reclaimed`: `session.resume` the stored id, mark the turn
  `interrupted` (`TurnStatus.interrupted` exists in the wire contract), show
  "interrupted by sleep — Retry".
- Hold `caffeinate -i` (or IOPMAssertion) while a turn is in flight; release on
  turn end. Verify with `pmset -g assertions`.
- Pass through `status.update`/`thinking.delta` retry text so "provider
  unavailable, retrying" never looks frozen.

## Real-hardware rerun (orchestrator → Oscar's Mac)

```bash
cd spikes/22-sleep-wake
HERMES_PROVIDER=openai-codex HERMES_MODEL=<model> ./run_on_real_mac.sh
# MODE=assertion ./run_on_real_mac.sh   # keep-awake variant
```

## Files

- `probe.py` — WS JSON-RPC probe: handshake, capabilities, session, prompt,
  15s heartbeat/45s deadline, auto reconnect + `events.since` + `activate`.
- `stub_model.py` — OpenAI-compatible SSE stub; `SLEEP:<n>` prompt → `terminal`
  tool_call `sleep n`; `/admin/close` kills open streams; logs every request.
- `freeze.sh`/`marker.py` — SIGSTOP/SIGCONT driver (sleep simulation on the VM).
- `run_on_real_mac.sh` — real-sleep rerun on physical hardware (env-driven provider).
- `transcripts/` — raw wire logs for each leg (`t_wall`/`t_mono`, dir, full frames).

Borrowed protocol knowledge from `NousResearch/hermes-agent`:
`tui_gateway/ws.py`, `tui_gateway/contracts/sessions.py` (methods +
`ws_orphan_reap` semantics), `tui_gateway/server.py` (reap grace = 20s),
`apps/shared/src/json-rpc-gateway.ts` + `json-rpc-channel.ts` (heartbeat/replay).
