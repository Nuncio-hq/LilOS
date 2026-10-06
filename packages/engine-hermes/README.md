# engine-hermes

The LilOS engine protocol over a live Hermes backend (`hermes serve` WS
gateway; `hermes acp` for sessions carrying MCP servers). WS sessions go
through `/api/ws` — `session.create`, `prompt.submit`, server→client
approval/clarify requests; the engine maps them onto the LilOS wire contract
(`packages/contracts`).

## Minimum supported Hermes version

**Hermes v0.21.5, release line 2026.9.24** — also exported as
`MIN_HERMES_VERSION` and reported on `describe()` under the `hermes_gateway`
capability's `detail.minVersion`. Once a session has started, `detail` also
carries the connected build (`gatewayVersion`, `releaseDate` from
`session.create`'s `info`).

That floor is the oldest build verified end to end by the live conformance
run. Older builds may still work — `session.create` negotiates its optional
fields (below) — but nothing older is guaranteed.

## Gateway compatibility negotiation (#50)

Hermes declares every gateway method's params as a pydantic `Params` model
with `extra="forbid"` (`tui_gateway/contracts/`). Sending a field the build
doesn't declare answers JSON-RPC `4000`:

```
invalid params for session.create: cwd_explicit: Extra inputs are not
permitted — the client and the Hermes backend are out of sync (different
versions); run `hermes update` and restart both
```

Builds differ inside the same release line (e.g. `cwd_explicit` exists on
this repo's CI build but not on the 2026.9.24 build it replaced), so the
engine does **not** version-gate. Instead, on an extra_forbidden rejection
naming a field, it drops that field and retries — once, remembered for the
life of the gateway connection (`droppedCreateFields` surfaces in
describe() so a client can see what was negotiated away).

Only metadata/precedence fields are droppable: `cwd_explicit`, `source`,
`title`, `close_on_disconnect`. Fields that carry session semantics —
`profile`, `cwd`, `model`, `provider` — are never silently stripped; a
gateway that refuses them fails the start with the gateway's own error.

`session.setModel` validates against `model.options` before running the
lazy `/model` switch, so an unknown id fails `MODEL_NOT_FOUND` immediately
instead of resolving and breaking the next prompt.

## Backend watchdog (#482)

`scripts/serve.ts` runs the backend through `HermesBackendSupervisor`
(`src/backend.ts`): it watches the `hermes serve` child's exit AND the
gateway socket; either loss marks the engine down — every in-flight turn,
open ask and pending gateway call settles fast with typed
`RPC_ERRORS.BACKEND_DOWN` (-32006) after a `turn.completed{refusal}` — and
the supervisor relaunches with capped backoff (a child surviving
`stableAfterMs` resets the budget; `maxAttempts` consecutive failures give
up as `failed` until a caller re-arms via `kick()`). The new gateway swaps
in through `setGateway`; stored sessions lazily `session.resume` on next
touch, so a thread outlives the backend that served it. A `session.resume`
that finds the stored row gone falls back to `session.create` — the new
stored ref, registry row and access hint are rebound there too, or the
next restart would resume the abandoned pre-fallback session and silently
rewind every turn since out of memory.

`describe()` reports `backend.{state,detail}` (`running` / `restarting` /
`failed`) — that is the surface the harness's liveness probe reads, so a
dead backend behind a live adapter shows as not-running instead of lying
`running` while calls hang. A resumed Hermes may finish the killed turn
server-side; its events mint a leg turn (D-#308), so `prompt` during that
leg legitimately answers `-32003` until the leg's `turn.completed` lands.

## Host-backend multiplex (#548)

Hermes runs one machine-level backend per OS user: since the multiplex
rework, a `hermes serve` without `--isolated` attaches to whatever owns the
host (Hermes Desktop, a `hermes` dashboard, another LilOS) and exits 0 —
the adapter used to read that as a crash and retry. An isolated `serve`
still binds its own port and keeps plugins, sessions and `session.resume`;
only the rendezvous record goes unpublished ("observe-only"), which matters
only to *other* Hermes processes looking for it.

The adapter probes `serve --help` once per binary and passes `--isolated`
when advertised. A build that still attaches (exit 0 with
`... already running on this host: PID …, port …`) or refuses the endpoint
(exit 78, `Refusing to start:`) rejects the spawn as `HermesHostConflict`
naming the owner; `scripts/serve.ts` exits
`HERMES_HOST_CONFLICT_EXIT_CODE` (87) so the harness launcher marks the
start fatal — the same slot as the too-old verdict — instead of counting
five restartable crashes. A mid-flight relaunch hitting the conflict marks
the backend `failed` immediately, and `kick()` re-arms it on demand once
the owner is gone.

## Live conformance run

```
bun run live:hermes                 # deterministic OpenAI stub (no real LLM)
HERMES_PROVIDER=hpc HERMES_MODEL=qwen3.8-flash-next bun run live:hermes
                                    # real provider + model on your sign-in
```

`scripts/live-hermes.ts` starts a real `hermes serve`, runs the conformance
suites over the in-process engine, then a compression + transport smoke leg.
Stub mode (no `HERMES_PROVIDER`) spawns `scripts/openai_stub.py` under an
isolated `HERMES_HOME` with a `lilos-stub` provider and `builder` profile —
clearly labelled, no real LLM.
