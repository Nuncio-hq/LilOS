# Decisions in force

Index of decisions that are in force now — not a history log. Rules for
entries live in `AGENTS.md` (Decisions). One agreed without an issue + merged
PR does not exist.

## Repo
- **D-#172 LilOS is source-available under the Elastic License 2.0** (licensor
  Nuncio; SPDX `Elastic-2.0` on every package; free to use/fork/modify/
  self-host incl. at work — never resell LilOS as a hosted service).
  Not: PolyForm NC (bans use at work), BSL (auto-converts), MIT (resale as a
  service). — #172

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
- **D-#113 A DM conversation owns its folder: `conversations.open` carries
  `cwd`, the relay stores it (nullable), and the engine sees it only as
  `cwd` on `session.start`.** Not: a per-employee fixed workdir, or folder
  moves inside a session (#10). — #113
- **D-#138 Message search indexes only the relay's stored messages via a
  SQLite FTS5 external-content table + triggers (migration v9).** Engine
  transcripts, tool output and attachments are never indexed (D-#25).
  Not: a separate search service, or indexing transcripts. — #138
- **D-#118 The signed-in human's identity (name, company, avatar colour) is
  relay-owned profile data: `profile.get`/`profile.update` on a singleton
  `profile` row (`settings.*` is #92's KV namespace); every surface reads it, nothing is hardcoded.** Prefill
  comes from `host.user` (the OS account's full name). Not: a `ME` constant
  in the web app, or identity fields on the employee record. — #118

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
- **D-#35 Ad-hoc (dev) bundles register agents via `launchctl bootstrap` +
  `~/Library/LaunchAgents` plists; Developer ID bundles keep
  `SMAppService.agent`.** SMAppService's launch constraint is keyed to the
  exact cdhash, so an in-place bundle swap permanently spawn-fails on
  ad-hoc builds; bootstrap resolves the `Program` path per spawn and
  survives swaps. Not: SMAppService for dev builds, or bootstrap for
  signed ones (it loses the Login Items approval item). — #35 · PR #81
- **D-#35 Auto-update replaces the whole `.app` in place (app + relay +
  harness share one version), then re-registers agents and gates on the
  post-update version handshake; on failure it restores the parked
  previous bundle and skips the release permanently.** Not: per-component
  versions, in-place binary patches, or auto-retrying a failed release. —
  #35 · PR #81

## Testing
- **D-#3 CI (GitHub Actions, setup-bun) runs with `engine-fake`; never a
  real LLM.** Not: real LLM in CI. — #3 · PR #14
- **D-#201 CI runs the fast checks (`verify:fast`) on every PR push and E2E
  only on `main` and ready, non-docs-only PRs; a PR's newer push cancels its
  older run; a failed E2E test retries once and is flagged flaky; the macOS
  release build runs on tags/dispatch only.** Not: full `verify` on every
  push, or re-running the whole job for a flake. — #201 · PR #202
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
- **D-#8 A model is `{provider?, id}` — never a joined `provider/model`
  string — carrying the engine's per-model `efforts`/`fast`; the picker's
  hide/show list is LilOS-owned (relay `settings`, one list for all
  employees). Hiring, the picker and persona edits speak `agents.*` /
  `models.*`: `agents.update` writes the fields the engine advertises
  (`detail.updatable`); there is still no profile delete — firing removes
  only the LilOS employee record.** Not: `splitModelRef`-style splitting, a
  sticky last-used model for new sessions (the engine owns defaults, #85), a
  hide list in localStorage or engine state, LilOS-owned profile CRUD, a
  persona read-only wire (was #8), or a delete method "for cleanup".
  — #8, #92, #123 · PR #46, #129, #146
- **D-#140 The picker always shows the model the session runs — the catalog
  plus the session's own pick when the catalog omits it, marked "Not in
  list"; the path back is the existing Refresh (`models.list
  {refresh:true}`), the engine's live catalog.** Not: merging configured or
  preset models into `models.list` — that re-advertises exactly what the
  engine hides on purpose (Hermes' account-gated models), so picks would
  fail — or engine-specific picker branches. — #140 · PR #177
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
- **D-#56 The terminal has one holder: a Workbench keystroke hands it to
  the user; `terminal_run`/`terminal_write` then fail `user_control` (HTTP
  409), in-flight runs too.** Hand-back is explicit (`term.release`) or
  automatic when the last viewer leaves. Not: silent interleaving, or a
  UI-only pause badge. — #56
- **D-#85 Release builds run the real engine (Hermes); `engine-fake` ships
  only in ad-hoc dev bundles (as the stamped default) and stays available
  for `bun run verify`/CI via `LILOS_ENGINE=fake`; `bun run app:local` /
  `build.ts --engine=hermes` stamps real Hermes into the ad-hoc bundle
  instead.** Provider/model come from Hermes' own config — LilOS stores no
  defaults. Hermes is found without PATH (`HERMES_BIN`, `~/.lilos/hermes-bin`,
  then known install locations), and a missing engine surfaces as a plain
  status reason — never a silent fake. Bundled executables never contain
  "hermes" in their name — managed Macs SIGKILL them by name, so the adapter
  ships as `lilos-engine-nous` (the engine id stays `hermes`).
  Not: a fake default in release, hand-editing installed launch-agent
  plists to pick an engine (lost on every rebuild), or asking for an MDM
  exception. — #85, #141

## Host
- **D-#11 Host reads (fs/git about the machine a session runs on) are served by the
  harness (`packages/host`), never by an engine; the wire is JSON-RPC 2.0 like
  the engine and app protocols. The real app reaches them as `POST /host` on the
  harness's loopback feed port, behind the install token (#113).** Not: fs/git
  tools on the engine protocol, or a per-app reimplementation of the calls. — #11
- **D-#37 Forge ops (PR view/comment/merge) are host API methods (`forge.*`)
  shelling out to `gh` with the signed-in user's auth; the merge result is the
  re-read PR state, not gh's stdout.** Not: a GitHub token stored by LilOS, or
  forge on the engine. — #37
- **D-#110 Opening files on the session machine is host API `os.*`:**
  `os.open {root, path, app, line?}` (argv exec, never a shell, target must
  stay inside the session folder) and `os.editors` (VS Code/Cursor/Zed/Xcode
  detected by bundle id in /Applications + ~/Applications; first in that
  order is the default until #132). Not: `open -a` guessed by name, or a
  persisted editor choice. — #110 · PR #143

## Mobile
- **D-#153 The relay binds the Tailscale address only when Oscar turns on
  phone access (opt-in); otherwise loopback only (D-#25). A QR never falls
  back to a loopback address** — it must name a host the phone can reach.
  Not: always-on LAN/tailnet listeners, or loopback in a QR. — #153
- **D-#153 Pairing = one-time grant (5 min TTL, single use, stored hashed)
  exchanged over the tailnet listener for a per-device credential (stored
  hashed; raw only in the exchange response). The phone keeps it in the
  Keychain; the Mac lists and revokes devices (revoke drops the live
  socket with ws close 4403 — the phone forgets the credential and lands
  on pairing, never a reconnect loop).** Not: sharing the install token
  (D-#25) with phones, a cloud relay, or DPoP. — #153 · #154
- **D-#153 The pairing URL keeps the secret in the fragment:
  `lilos://pair?host=<tailscale-host>:<port>#code=<grant>` — fragments never
  leave the device in a URL copy or server log.** Not: secret in the query
  string. — #153
- **D-#154 The phone app is Expo (dev client, iOS first) rendering
  `packages/ui-native` over `packages/client-runtime` — the supervisor
  (one retry owner) and the directory cache are runtime-neutral, RN glue
  (AppState/NetInfo/Keychain) lives only in `apps/mobile`.** Not: per-app
  reconnect loops, or RN imports inside client-runtime. — #154

## UX
- **D-#114 The Workbench lives only in Focus mode, and opening a session
  goes straight into Focus** (`/dm/$employeeId/$conversationId/focus`; the
  420px thread panel stays the quick peek). Changes = uncommitted files vs
  `HEAD` (`git.diff` with no `base`; untracked included). Not: Workbench in
  the thread panel, or a review step between DM and Focus. — #114 · PR #149
- **D-#19 A control renders only when its handler is passed; the app shows
  only working surfaces (no placeholder buttons).** Conversation UI = shared
  pieces (`AgentTurn`, `UserTurn`, cards, composers) + thin frames
  (`ThreadView`, `FocusView`); frame-only features are pieces the frame adds,
  not props of `AgentTurn`. Not: variant/mode props inside `AgentTurn`, a god
  component accumulating optional props. — #19 · PR #40
- **D-#105 `@`-file mentions send the relative path as plain text
  (`@src/app.tsx`), never file contents or engine-specific blocks; one `@`
  menu lists Employees then Files.** Not: content inlining, a second
  popover, a `#` trigger. — #105

## Status
- **D-#33 `system.status` legs carry `{state, reason}`; `blocked` (#53) means
  down only because an upstream leg is down — neutral, never counted as an
  issue. Wire reasons stay raw for diagnostics; the plain-language mapping
  lives once in `packages/client-runtime`.** Not: friendly strings composed in
  the relay or in UI components. — #33 · #53

## Structure
- **D-#3 One-way deps: `apps/*` → `packages/*`, never back; engine packages
  depend only on `contracts`.** Types crossing a boundary live only in
  `packages/contracts` (Zod). Not: Hermes-specific types in app code.
  The engine seam design itself is #5, not decided here. — #3 · PR #14
- **D-#12 UI lives in `packages/ui` (`@lilos/ui`); prototype = packages/ui +
  mock data + fake engine + app wiring.** Presentational only: props in,
  callbacks out; UI domain types in `packages/ui/src/types.ts`.
  Not: copying prototype components into `apps/web` (drift). — #12 · PR #16
