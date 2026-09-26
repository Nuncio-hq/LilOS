# Decisions in force

Index of decisions that are in force now — not a history log. Rules for
entries live in `AGENTS.md` (Decisions). One agreed without an issue + merged
PR does not exist.

## Stack
- **D-#3 Bun is the runtime + package manager** (workspaces, pinned
  `packageManager` + `.bun-version`); Biome for lint/format; Vitest (unit) +
  Playwright (E2E/screenshots) behind one `bun run verify`.
  Not: pnpm/Node, ESLint + Prettier, per-package ad-hoc scripts. — #3 · PR #14
- **D-#3 Server: Hono on Bun (HTTP + WS).** Not: raw `Bun.serve` or Elysia —
  a benchmark (in #3) showed the framework is not the bottleneck; Elysia is
  Bun-locked. — #3 · PR #14
- **D-#3 DB: SQLite via `bun:sqlite` + Drizzle; Postgres later through the
  same Drizzle schema.** Not: raw SQL, or Postgres now. — #3 · PR #14
- **D-#3 Bun-only APIs (`bun:sqlite`, `Bun.serve`) only at app entry points;
  `packages/*` stay runtime-neutral.** Not: Bun APIs everywhere. — #3 · PR #14
- **D-#25 The relay is its own process, local first** (binds 127.0.0.1,
  per-install token); remote = change the address, not the code.
  Not: embedded in apps/web, or remote-first. — #25 · PR #41

## Data
- **D-#25 The relay owns visible messages; the engine owns transcripts**
  (tools, reasoning). Not: a transcript copy in LilOS — no drift, no
  sensitive reasoning data at rest here. — #25 · PR #41
- **D-#25 A DM is a private channel with exactly one employee; each
  conversation is one engine session** (`engineRef`, set by the harness).
  Not: group DMs, or threads detached from sessions. — #25 · PR #41
- **D-#29 LilOS never deletes an engine profile; an employee is only the
  LilOS record pointing at engine runtime state.** Remove-from-company
  deletes channels/conversations/the record; `agents.*` has no delete.
  Not: delete profile on remove. — #29

## Web
- **D-#3 Web: React 19 + Vite + Tailwind v4 + shadcn (base-nova) + AI
  Elements (mandatory) + TanStack Router + nanostores.**
  Not: Next.js. — #3 · PR #14
- **D-#3 `prototype/` is the UI source of truth** (= future `packages/ui` +
  mock data); a UI/UX change lands in a prototype PR first, Oscar accepts,
  then it is implemented. Not: hand-copied UI in the web app. — #3 · PR #14

## Desktop
- **D-#3 Desktop: Electron (later slice).** Chromium parity with web;
  Playwright can drive it on macOS. Not: Tauri (WKWebView drift, no macOS
  WebDriver). — #3 · PR #14
- **D-#34 Relay + harness are launchd agents registered via
  `SMAppService.agent(plistName:)` with bundled helper binaries** (Login
  Items approval only; upgrade = `unregister()` → `register()` on version
  change). Not: user-facing `launchctl` steps, LaunchDaemons, or
  app-process children that die on quit. — #34 · PR #57
- **D-#34 Keep-awake is `caffeinate -i -w <harness pid>` held only while a
  turn runs.** Not: a permanent assertion, or changing `pmset` defaults. —
  #34 · PR #57
- **D-#34 Wake recovery: a clock-drift watchdog detects sleep; a turn lost
  across sleep or engine restart ends `interrupted` with a Retry note.**
  Not: a spinner that never settles, or silently dropping the turn. — #34 ·
  PR #57

## Testing
- **D-#3 CI (GitHub Actions, setup-bun) runs `bun run verify` with
  `engine-fake`; never a real LLM.** Not: real LLM in CI. — #3 · PR #14
- **D-#3 Local verify uses a real LLM via Hermes (HPC `qwen3.8-flash-next`
  local / `openai-codex` cloud); hand-offs state which was used; if both
  fail, tell Oscar.** Not: silently falling back to mock. — #3 · PR #14

## Engine
- **D-#6 The engine protocol is JSON-RPC 2.0 over an ACP-shaped core
  (`session.start`/`prompt`/`interrupt`/`request.respond`/`events.since`),
  declared once in Zod and generated to JSON Schema for non-TS clients; every
  event carries `seq`; engine asks ride `request.opened` events so they replay
  after reconnect; engines advertise behavior as capability descriptors, and
  the app renders from capabilities.**
  Not: Hermes-specific names or types in `contracts`/`engine-fake`/
  `engine-conformance`, `if engine == "..."` branches, server-to-client
  request frames. — #6 · PR #39
- **D-#8 Hiring and the model picker speak `agents.*` / `models.*`; the
  protocol has no profile delete — firing removes only the LilOS employee
  record.** Not: LilOS-owned profile CRUD, or a delete method "for cleanup".
  — #8 · PR #46
- **D-#26 The harness supervises the engine and is the only thing that talks
  to it.** It owns launch (`hermes serve` on 127.0.0.1 with a generated
  token, via `packages/engine-hermes`), crash restart with bounded backoff,
  conversation↔session binding, final-answer posts, and ask relaying.
  Not: the app or relay calling an engine directly. — #26 · PR #48
- **D-#36 Agents use app surfaces through the LilOS MCP server + `lilos` CLI
  owned by the harness** (attached per session via `session.start
  { mcpServers }`); the Workbench Terminal/Preview tabs watch the same
  surfaces live and take input. Not: engine-specific UI toolsets (Hermes
  `desktop_ui` / `drive_preview` / `read_terminal`). — #36 · PR #54

## Host
- **D-#11 Host reads (fs/git about the machine a session runs on) are served by the
  harness (`packages/host`), never by an engine; the wire is JSON-RPC 2.0 like
  the engine and app protocols.** Not: fs/git tools on the engine protocol, or a
  per-app reimplementation of the calls. — #11
- **D-#37 Forge ops (PR view/comment/merge) are host API methods (`forge.*`)
  shelling out to `gh` with the signed-in user's auth; the merge result is the
  re-read PR state, not gh's stdout.** Not: a GitHub token stored by LilOS, or
  forge on the engine. — #37

## UX
- **D-#19 A control renders only when its handler is passed; the app shows
  only working surfaces (no placeholder buttons).** Conversation UI = shared
  pieces (`AgentTurn`, `UserTurn`, cards, composers) + thin frames
  (`ThreadView`, `FocusView`); frame-only features are pieces the frame adds,
  not props of `AgentTurn`. Not: variant/mode props inside `AgentTurn`, a god
  component accumulating optional props. — #19 · PR #40

## Structure
- **D-#3 One-way deps: `apps/*` → `packages/*`, never back; engine packages
  depend only on `contracts`.** Types crossing a boundary live only in
  `packages/contracts` (Zod). Not: Hermes-specific types in app code.
  The engine seam design itself is #5, not decided here. — #3 · PR #14
- **D-#12 UI lives in `packages/ui` (`@lilos/ui`); prototype = packages/ui +
  mock data + fake engine + app wiring.** Presentational only: props in,
  callbacks out; UI domain types in `packages/ui/src/types.ts`.
  Not: copying prototype components into `apps/web` (drift). — #12 · PR #16
