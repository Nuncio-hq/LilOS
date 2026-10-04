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
- **D-#329 Outside contributors work from forks; only Oscar triages and
  merges.** New issues/PRs land in the board's Inbox. `main` ruleset: PRs
  only, `verify` + `check` (DCO) required, no force-push or deletion, 0
  approvals. Not: write access for collaborators (a `v*` tag runs the signed
  release), required CODEOWNERS approval (Oscar can't approve his own PRs).
  — #329

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
  `cwd` on `session.start`. Add a folder always opens LilOS's in-app
  dialog, desktop included.** Not: a per-employee fixed workdir, folder
  moves inside a session (#10), or the macOS open panel (#208). — #113
- **D-#138 Message search indexes only the relay's stored messages via a
  SQLite FTS5 external-content table + triggers (migration v9).** Engine
  transcripts, tool output and attachments are never indexed (D-#25).
  Not: a separate search service, or indexing transcripts. — #138
- **D-#300 The context meter's usage + contextWindow persist on the
  conversation row** (the relay writes `turn.completed.usage`, fenced by
  `usage_session_id`/`usage_seq`); an `events.since` on a dead session id
  degrades to an empty `closed` transcript at the harness passthrough, and
  rebind stays a send-path `session.start` only. Not: meter from replayed
  events only (the #300 bug), or rebind on thread open (mints sessions on
  view). — #300
- **D-#118 The signed-in human's identity (name, company, avatar colour) is
  relay-owned profile data: `profile.get`/`profile.update` on a singleton
  `profile` row (`settings.*` is #92's KV namespace); every surface reads it, nothing is hardcoded.** Prefill
  comes from `host.user` (the OS account's full name). Not: a `ME` constant
  in the web app, or identity fields on the employee record. — #118
- **D-#315 Wait-state lives on the message row, not the client: `dropped` /
  `removed` / `claimed` flags (`messages.drop`/`remove`/`send`/`claim`,
  `message.changed`) drive the waiting and not-sent trays;
  `client-runtime`'s `waitingMessages` plus `deliveredSeq` classify.** The
  harness owns the semantics — a stranded accepted steer reconciles to
  `dropped`, and a send committed to dispatch gets `claimed` so the tray's
  Remove boundary is claim, not delivery (#377). Not: tray state kept in
  component memory (a reload must show the same tray). — #315 · PR #358
- **D-#403 A Stop's scope is causal, not temporal: `turn.interruptRequested`
  carries `afterSeq` (the channel seq it follows) and the harness parks any
  send at or below it wherever it surfaces.** The event bus and
  `channelMessages` are unordered paths, so a pre-Stop send can land after
  the drain. Not: ordering the bus against the store, or snapshotting which
  rows were visible at Stop time. — #403

## Web
- **D-#3 Web: React 19 + Vite + Tailwind v4 + shadcn (base-nova) + AI
  Elements (mandatory) + TanStack Router + nanostores.**
  Not: Next.js. — #3 · PR #14
- **D-#3 `prototype/` is the UI source of truth** (= future `packages/ui` +
  mock data); a UI/UX change lands in a prototype PR first, Oscar accepts,
  then it is implemented. Not: hand-copied UI in the web app. — #3 · PR #14
- **D-#246 The theme lives once in `packages/ui/src/theme.css`** — tokens,
  glass, motion and the one-window rules; `apps/web` and `prototype/web` both
  import it so they cannot drift (drift was the #230 regression class). The
  app root always carries `.lilos-desktop` (merged window); `.lilos-float`
  (browser tabs only, off `window.lilos.isDesktop`) adds the floating margin
  + colour field — Electron's OS window is the frame. Not: a second copy of
  the palette in an app entry, or wallpaper inside the desktop window. — #246

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
- **D-#206 The signed register path boots out launchd jobs SMAppService
  doesn't own (ad-hoc `bootstrap` leftovers, other-bundle programs) and
  treats an "lacks required entitlement" `unregister()` error as
  not-ours, not a failure.** `SMAppService.status` is blind to
  bootstrapped jobs — registering over one keeps the old binary and pins
  the version store. Not: trusting `status` alone, or failing the
  register on that error (rolls back working installs). — #206
- **D-#388 `lilos-harness --compile` marks `chromium-bidi` external.**
  playwright-core requires it lazily on the BiDi transport only — the browser
  surface drives Chromium over CDP and never loads it, so the missing package
  is excluded at bundle time, not vendored or imported dynamically.
  Not: installing chromium-bidi for the bundler, or marking playwright
  external (the browser surface must stay bundled). — #388 · PR #389
- **D-#232 Native chrome: `titleBarStyle: "hiddenInset"` + `vibrancy:
  "sidebar"`; the renderer owns the drag regions** (`lilos-drag` on header
  strips, interactive children `no-drag`) and pushes its theme to
  `nativeTheme.themeSource` so the vibrancy material matches app tokens.
  The renderer must also re-push the region map when a strip or its
  contents change — `watchDragRegions()` flips each `.lilos-drag` through a
  two-frame style diff, since the OS map goes stale for headers mounted
  under a stationary cursor until a pointer event lands. Not: a default
  framed window, or a frameless window with custom-drawn
  traffic lights (misses native drag/zoom/full-screen for free). — #232,
  #301

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
- **D-#347 Spawned dev/test processes die with their spawner: every
  long-lived entry point runs an orphan watchdog (reparent or parent's
  reparent past a `bun run` shim → exit), and Playwright's globalTeardown
  sweeps only tags whose owning worker is dead.** Not: runner-side
  `pkill`/afterAll as the sole teardown (dies with the runner), or stdin-EOF
  only (detached spawns never see EOF). — #347 · PR #351

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
- **D-#482 The Hermes adapter owns its `hermes serve` child's lifetime;
  the harness watches the adapter, never the child.** The adapter's backend
  supervisor watches both the child exit and the gateway socket; either
  loss fails every in-flight and new engine call fast with typed
  `BACKEND_DOWN` (-32006 → app `engine_unavailable`), then relaunches with
  capped backoff and swaps in the new gateway — stored sessions lazily
  `session.resume` on next touch (a completed dead turn first emits
  `turn.completed{refusal}`; a turn the restarted backend finishes
  server-side completes as a leg under D-#308). `describe()` carries
  `backend.{state,detail}` with a short post-flap exposure so a sub-second
  restart still registers. The harness side only probes `describe` (2s /
  1.5s): a coded answer keeps the adapter alive on reported state, dead
  air twice restarts the adapter process. Not: the harness watching the
  hermes child itself, requests queueing on a dead socket, or per-request
  waits bounded by nothing. — #482
- **D-#36 The agent gateway is the one agent surface.** Every engine
  session gets a gateway scope bound to its employee/thread; its tool
  calls reach LilOS through one endpoint and the scope resolves the
  binding — never agent-passed ids (the engine's own session id is an
  alias). The tool catalog is declared once in `packages/contracts` with
  canonical `<area>_<action>` names (`thread_*`, `terminal_*`,
  `browser_*`, `workbench_*`); MCP `tools/list` (stdio + streamable
  HTTP), the `lilos` CLI, and the versioned host policy all render from
  it. Per-engine adapters (Hermes plugin, Codex app-server, Claude SDK)
  only attach the catalog — they never grow
  their own tool list. Not: attaching MCP only through ACP, or
  engine-specific UI toolsets (Hermes `desktop_ui` / `drive_preview` /
  `read_terminal`, was #36). — #36, #337 · PR #54
- **D-#308 Every leg is a turn.** A post-turn leg mints its own turn id —
  `ref` echoes the prompting message, `initiatedBy:"agent"` marks
  engine-opened work. Not: stamping legs on the settled turn id, or the
  mapping layer guessing ownership. — #308
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
- **D-#134 Rewind = harness-owned file checkpoints + an engine `rewind`
  capability for conversation memory.** Before each user turn the harness
  snapshots the session folder into a LilOS shadow git store
  (`~/.lilos/checkpoints/<folder-hash>`, `GIT_DIR`+`GIT_WORK_TREE`+`GIT_INDEX_FILE`
  — the user's `.git`/index/stash/HEAD are never touched, non-git folders
  work); the checkpoint id rides on the user message, and the relay marks
  the dropped tail `rewound` (hidden, kept for audit). `session.rewind
  {toTurn}` is a declared capability — transports that can't rewind the
  engine's memory (ACP today) still get the file restore plus a plain
  "still remembers" note and Start a new session.
  Not: engine-owned file checkpoints (opt-in, transport-dependent),
  deleting messages, or the engine owning the folder snapshot. — #134
- **D-#106 Access levels are LilOS data on the conversation; Full access
  is enforced by the harness auto-answering approvals (`once`), engine-neutral —
  the engine's own approval policy stays a separate `approval_policy`
  capability.** Not: an engine-specific yolo as the only mechanism, or the
  access level living in engine session state. — #106
- **D-#180 Plans and task lists are engine state: the engine streams a full
  snapshot on every change (`plan.updated` keyed by `planId`), and LilOS
  derives the Tasks card / Plan card / Workbench Plan tab from events
  only.** `kind:"tasks"` (Hermes `todo_list`, ACP `plan`) ticks without
  approval; `kind:"plan"` waits on a `plan` EngineRequest answered
  approve / reject / change{text}. Not: a LilOS-owned plan store, patch or
  delta plan events, or rendering these without a declared `plan`
  capability (D-#19). — #180
- **D-#179 Subagent runs and background jobs exist only as engine events /
  `jobs.*` answers — LilOS stores no job/subagent state** (`subagent.*`,
  `job.*`, `jobs.list`/`jobs.stop` under `background_jobs`; a helper that is
  another employee surfaces as `subagent.started.employee` + a session link
  in its DM, per D-#25). Job output lives in engine memory (rolling tail);
  after a reconnect the list comes from `jobs.list`, never a LilOS copy.
  Not: a LilOS-side jobs/subagents table, or a copy of a helper's turns. —
  #179
- **D-#327 A turn settles when its session can no longer run it**
  (`session.state` idle → done, closed/error → stopped, or superseded by a
  later turn) inside `reduceSessionEvents` — replay-safe for every client.
  Helper rows settle on closed/error only client-side (async delegates
  outlive idle, #309); an ACP-dispatched row the wire can never close is
  settled stopped by engine-hermes `Session.setState` once the session
  leaves running. Not: settling helpers on idle, or per-UI guesses. — #327
- **D-#258 `deliveredSeq` is a crash-durability watermark, not "turn
  started"** — it must stay behind until the turn's outcome is secured
  (turn end) or a restarting harness can't rebind its orphan session.
  "Queued" means past the watermark AND no `turn.started` ref — the
  client reads the ref, the wire stays as-is. Not: advancing the mark at
  turn.started. — #258
- **D-#334 The reasoning stream is `reasoning.delta` only.** Hermes'
  `reasoning.available` is a per-message preview of the assistant text
  (≤500 chars, tags stripped — `tool.progress` upstream), never a delta;
  engine-hermes drops it at the adapter. Not: `available` mapped as
  append or replace on `turn.delta` (injects the answer into the
  Reasoning card). — #334 · PR #349

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
  detected by bundle id in /Applications + ~/Applications). The default
  editor is the Settings pick in relay `settings.defaultEditor` (was: first
  in catalog order until #132); it leads every detected list. Not:
  `open -a` guessed by name. — #110 · PR #143

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
- **D-#157 Engine events reach the phone through the host: the harness
  re-publishes each event of a conversation-bound session as `engine.event`,
  the relay re-emits it on the conversation's channel, and replay goes
  through `session.events {conversationId}` gated on `conv.engineRef`.**
  Not: an engine socket on the phone, a verbatim `events.since`, or device
  access to raw host methods (same scoping as `folders.detail`, #156). — #157
- **D-#238 A device-scope client may list folders only under the Mac user's
  home — `folders.browse`/`folders.discover` relay-forward to the harness,
  which enforces the boundary server-side (realpath under home, dot-dir
  segments refused), and `folders.add` accepts only home paths from devices
  (relay-gated; recents still store `~/x`).** Not: exposing host `fs.*` to
  the phone directly. — #238
- **D-#161 Push goes Mac relay → Expo push service → APNs. The phone
  registers its Expo push token (+ per-kind prefs) with the relay after
  pairing, tied to the device id.** Not: a LilOS cloud relay; direct APNs
  with an Apple key on the Mac; silent/background pre-sync pushes. A
  sleeping Mac sends nothing (accepted). — #161 · PR #283
- **D-#259 Mobile markdown stays bespoke — fences and GFM tables are
  `Prose` block types; fences highlight via `lowlight`.** Not: RN
  markdown libs (no tables, highlighting, or streaming states). — #259 · PR #316

## UX
- **D-#114 The Workbench lives only in Focus mode, and opening a session
  goes to the thread panel first — the panel's ↗ is the way into Focus**
  (`/dm/$employeeId/$conversationId`, then `…/focus`; the 420px peek stays
  beside the feed). Changes = uncommitted files vs `HEAD` (`git.diff` with
  no `base`; untracked included). Not: straight to Focus (was #114);
  Workbench in the thread panel. — #114 · PR #149, #195
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
- **D-#320 Turn-block collapse state is user-owned, keyed by
  `${conv.id}:${turnId}:${block}` in `packages/ui/src/lib/block-state.ts`.**
  Auto-open is only a default while a turn runs. The live→relay-row id swap
  can remount the card, so the choice also lives outside React state; web
  row keys use `r.turnId` (dm.tsx stamps the conv id in). Not: auto-open as
  a lock, per-component `useState` only. — #320 · PR #352

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
