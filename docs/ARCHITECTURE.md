# LilOS architecture

How the pieces fit. `AGENTS.md` holds the rules; `docs/DECISIONS.md` holds
the decisions in force — this file is the map.

## Components

```
apps/web      ─┐  the app Oscar sees (React)
               ├─ websocket, JSON-RPC
apps/relay    ─┘  fans out sessions, owns company state, answers system.status
                  ▲
                  │ harness.report / protocol socket
apps/harness      supervises the engine process on the session machine —
                  starts it, restarts it, reports its state
                  │
                  ▼ spawn + supervise
packages/engine-* engine adapters: `engine-fake` (CI) and `engine-hermes`.
                  An adapter serves the LilOS engine protocol at
                  ws://127.0.0.1:<port>/ws and owns the engine subprocess.
```

- `packages/contracts` — Zod schemas for every boundary type; the only place
  those types live.
- `packages/client-runtime` — the app's model of the wire: connection,
  status mapping (plain-language reasons), diagnostics.
- `packages/ui` — every UI component; the prototype renders them first.

## Engine requirements

The harness launches exactly one engine kind, chosen by config
(`LILOS_ENGINE`, `engine:` in the config file, default `hermes`).

**Minimum Hermes version: `MIN_HERMES_VERSION` in
`packages/engine-hermes/src/version.ts`** (currently `0.21.5`). The gateway
handshake calls `client.capabilities`, which older Hermes builds answer
with `-32601` "unknown method" — v0.20.2 dies there, v0.21.5 works.
Enforced twice (#95):

1. Up front: the launcher runs `hermes --version` before spawning; an older
   Hermes is a fatal start verdict (no retries) carrying the sentence
   `Hermes <found> is too old — LilOS needs <min> or newer. Run
   \`hermes update\`.`
2. On the handshake: when the adapter still hits -32601 (an unreadable
   version probe, for instance) it prints the same sentence on stderr and
   exits with `HERMES_TOO_OLD_EXIT_CODE` — the launcher marks that code
   fatal for the same verdict.

Engine start failures surface verbatim through supervisor detail →
`harness.report` → `system.status` → the status dialog and the DM composer
note. A child killed by a signal reports `killed by SIG<X>` (never
`code null`); after the restart budget the plain reason is `The engine was
stopped by the system (<SIG>) — a device security policy may be blocking
it.` (#95).

## Agent Gateway (#336)

How employees see and use LilOS. Being built in #337–#340; until then only
the `browser_*` / `terminal_*` surfaces and `lilos` CLI from D-#36 exist.

```
Relay (company, channels, threads, messages)
  │
Harness ── Agent Gateway: tool catalog (contracts) · session → employee/thread
  │        binding · versioned host policy · MCP over HTTP + `lilos` CLI
  ├── Hermes ← plugin `lilos` (tools, host policy, blocks its own browser)
  ├── Codex  ← app-server + MCP (later, #342)
  └── Claude ← Agent SDK + MCP (later, #342)
```

A tool call resolves its scope from the session that made it, then goes to
the relay over the harness' existing connection.
