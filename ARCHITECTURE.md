# LilOS — Architecture & Product Contract

LilOS is a personal CompanyOS: a single web app where Oscar runs his AI
company. Hermes is the engine and harness; LilOS is a **pure UI** on top of
it — sessions, memory, skills, cron, and profiles all stay in Hermes. The
goal (App Factory) is to use this surface to build apps and marketing,
organized like a company (teams, roles, work queues).

This repo is **not** a NuncioCrew/Buzz project. No relay, Nostr, or
`docs/crew/` conventions. It talks to one Hermes backend over JSON-RPC.

## Why this exists

- The Crew Tauri desktop UI is expensive to change (thin-fork budget,
  upstream sync). LilOS has no such tax: it's greenfield, UI-only.
- Hermes Desktop is feature-rich but wider than what one founder needs.
  LilOS ships only the surfaces an operator of an AI company actually uses.
- This is Hermes' own supported pattern: the stock Desktop app is just a
  React renderer over a headless `hermes serve` backend. LilOS swaps the
  renderer, never the engine.

## Product shape

**CompanyOS is the type; App Factory is the job it does.** Every screen is a
view over an existing Hermes primitive — the UI never keeps its own
transcript/session database:

| Surface | Hermes primitive (engine-owned state) |
|---|---|
| Inbox — chat with agents, approvals | sessions, `prompt.submit`, streaming events |
| Team — agents with roles/models | profiles + Bot mode |
| Board — company work | kanban |
| Automation — routines, monitors | cron jobs, webhooks |
| Knowledge — what the company learned | skills + memory + curator |
| Factory — build an app / marketing campaign | kanban task → builder session on a git worktree → real artifacts (repo, preview, screenshots, copy) → owner approve |
| Spend — cost per agent/job | `session.usage`, insights |

A Factory "job" has no LilOS-side record: it is a kanban task plus a builder
session plus real output in git. Closing the app loses nothing.

## Engine seam (Spike 000 — PASS, see SPIKE000.md)

`hermes serve` → `ws://…/api/ws`, the same JSON-RPC the official Desktop app
uses. Verified end-to-end 2026-09-21: `gateway.ready` →
`client.capabilities` → `session.create` → `prompt.submit` → streamed
`message.delta` → `message.complete` with usage, full turn in 3.7 s, and a
browser-style Origin (`http://localhost:5173`) accepted on the loopback bind.

Protocol rules the UI must honor:

- Start the backend with a fixed `HERMES_DASHBOARD_SESSION_TOKEN`; the WS
  connects with `?token=`.
- After `gateway.ready`, call `client.capabilities {server_requests:true}`
  once, then answer server→client requests (`approval`, `clarify`, `sudo`,
  `secret`, `vault.*`, …) or refuse with `-32601`. Silence stalls the agent.
- Rewind = `prompt.submit` with `truncate_before_row_id` +
  `confirm_truncate`; rebind row ids from `survivor_user_row_ids`.
- Reconnect via `session.resume` → `inflight` + `open_requests` replay.
- The model picker uses `model.options` / `/api/model/options`, never
  `GET /v1/models`.
- Multi-client attach is supported: two windows see the same stream.

## Stack & decisions

- **Vite SPA + React + strict TypeScript + Tailwind + shadcn/ui + TanStack
  Query.** One `src/lib/rpc.ts` wraps the JSON-RPC socket; everything else
  consumes it. Deliberately **not** create-t3-app (Next/tRPC/Prisma = an own
  backend, which contradicts the pure-UI rule). DX/typesafety ethos is taken
  from T3.
- **Web first; Electron shell later** (spawns the backend locally, same
  renderer). Mobile = responsive PWA over the tailnet first; native only if
  the web story proves insufficient (T6).
- **Personal use only.** No multi-user auth, no relay, no org features. The
  trust boundary is the local token.
- **UI-owned durable state:** only product chrome — layouts, filters, view
  prefs — in `localStorage`. Never agent state.

### Kill list (never in LilOS)

pets, skin editor, MoA picker, dashboard admin (MCP catalog / webhook
editor), file browser, TUI widgets, anything the engine already owns.

## Adapter stance

`rpc.ts` sits behind an engine-adapter interface so a second adapter (ACP,
for Claude Code / Codex engines) can be added later without UI rewrites. The
MVP ships Hermes-only; capability descriptors gate UI features, no scattered
`if engine === …` branches.

## Roadmap

- **Slice 1 — Cockpit** (issue #1): connect, session list, chat with
  streaming + tool cards, approvals, model picker, usage bar.
- **Slice 2 — CompanyOS**: Board (kanban), Team (profiles), Automation
  (cron) as views.
- **Slice 3 — App Factory**: job flow on top of kanban + worktree builder
  sessions + evidence → approve/reject.
- **Slice 4 — PWA/mobile**, then Electron shell.
