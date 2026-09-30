---
name: testing-mobile-simulator
description: How to test the LilOS iOS app (apps/mobile) end-to-end in Simulator on this macOS VM — picking the right booted device, simctl app control, the relay, pairing state, cache/offline behavior, evidence capture quirks, plan/task-list leg timings, building with Xcode 26.x (never the Xcode 27 RC, #275), custom/cap-less engine-fake variants, and harness capability plumbing gotchas.
---

# Testing the LilOS iOS app in Simulator on the macOS VM

apps/mobile is an Expo dev-client app (`com.nuncio.lilos.mobile`) that pairs with a
real relay and renders Home from an on-device cache. Metro must be running for the
JS bundle; the relay provides data.

## Pick the right booted device

Several simulators of the SAME model name (e.g. two "iPhone 17") can be booted;
window titles don't disambiguate them — but the subtitle iOS version can
(e.g. "iPhone 17 iOS 27.0" vs "iOS 26.5"). Find the one that has the app installed:

```sh
xcrun simctl list devices | grep Booted
xcrun simctl listapps <udid> | grep -i lilos   # the device that lists the app owns the window
xcrun simctl get_app_container <udid> com.nuncio.lilos.mobile app
```

A click on a back Simulator window's title bar brings THAT device forward and
steals subsequent taps — re-check the frontmost title bar after any click near
a window edge, and re-foreground the right window before continuing.

## App control (from the shell — drives the visible Simulator window)

```sh
D=<udid>
xcrun simctl terminate $D com.nuncio.lilos.mobile   # true cold start on next launch
xcrun simctl launch   $D com.nuncio.lilos.mobile    # prints new pid; foregrounds a suspended app
xcrun simctl io $D screenshot /tmp/shot.png          # full-res device still (~0.8–1s latency)
xcrun simctl openurl  $D 'lilos://pair?host=<h:port>&name=<n>#code=<c>'
xcrun simctl ui       $D appearance dark|light       # theme legs; no reboot needed
```

**`xcrun simctl io $D recordVideo` produces 0-byte files on this VM** — do not use
it. Record the Simulator window with the agent's own screen-recording tool instead.

## Relay (the app's only backend)

```sh
cd /Users/devin/repos/LilOS
LILOS_RELAY_HOME=/tmp/lilos-home LILOS_RELAY_TAILSCALE_IP=172.16.4.2 \
  bun apps/relay/src/index.ts            # default port 4577
lsof -ti :4577                           # empty = down; kill with | xargs kill
lsof -nP -i :4577                        # shows LISTEN addrs + app TCP connections
```

- The tailscale stand-in IP lives on `lo0` and VARIES per VM — find it with
  `ifconfig lo0 | grep 'inet 172\.'` (this VM: 172.16.5.2). A wrong IP makes
  `pairing.offer` fail `tailscale_unavailable` (the bind fails, not the probe).
- A down relay gives a FAST ECONNREFUSED, not a TCP timeout.
- The startup log prints `listening on http://127.0.0.1:4577` — cosmetic: the
  tailscale listener binds lazily on `pairing.offer` (phoneAccess.enable), so
  check `lsof -nP -iTCP:4577 -sTCP:LISTEN` for the `172.x` row AFTER an offer.
- Whole env in one shot: `bash scripts/live/156.sh` (relay + harness on
  engine-fake + seeded employee/folder + printed pair link; `LILOS_ENGINE=hermes`
  for the real engine; set `TAILSCALE_IP` to the lo0 IP).
- A visible Terminal window running the relay in the foreground (positioned beside
  the Simulator: `osascript -e 'tell application "Terminal" to set bounds of front
  window to {8,50,360,700}'`) makes relay kill/restart moments self-evident in a
  screen recording.

## Pairing + cache state (what "offline" tests depend on)

- Paired Macs (incl. device credential) live in the Keychain via SecureStore key
  `lilos.connections.v1`; the directory cache lives in AsyncStorage.
- Cold launch renders cached Home instantly (employees, channels) BEFORE the
  socket connects; the offline banner "Can't reach <Mac name>" + red header Mac
  icon appears once the first connect attempt fails.
- Retries are owned by the supervisor on a [3,4,8,16]s backoff ladder — after a
  relay restart the app recovers on its own in ~3–20s with NO user interaction
  (up to ~25s if the ladder is on the 16s rung + 15s connect timeout worst case).
- Re-pair: mint a grant, then `simctl openurl <udid>
  'lilos://pair?host=…&name=…#code=…'` → tap "Allow" on the local-network
  prompt AND "Open" on the "Open in LilOS?" sheet (they appear stacked), then
  "Continue" on the "You're connected" screen. Codes expire in 5 min.
- Mint WITHOUT reseeding (keeps Home unambiguous in recordings):

```sh
cat > /tmp/mint-offer.ts <<'EOF'
import { RelayClient } from "/Users/devin/repos/LilOS/packages/client-runtime/src/index";
import { readFileSync } from "node:fs";
const home = process.argv[2];  // relay home holding relay-token
const token = readFileSync(home + "/relay-token", "utf8").trim();
const u = new RelayClient({ url: "ws://127.0.0.1:4577/ws", token, client: { name: "mint", version: "0" } });
await u.connect();
console.log(JSON.stringify((await u.request("pairing.offer", {})).offer));
EOF
bun /tmp/mint-offer.ts <relay-home>   # {"host","code","name","expiresAt"}
```

- "Forget this Mac" (Settings tab) deletes the SecureStore key AND the AsyncStorage
  cache; proof = the app drops to the onboarding Welcome screen.

## Device peers vs token peers (wire scope)

`session.hello` has two auth shapes: install token (trusted local tools) vs
`deviceId` + `credential` (paired phones). Phones are refused
PAIRING_ADMIN_METHODS (`pairing.offer`, `pairing.disable`, `devices.list`,
`devices.revoke`) — `forbidden: paired devices can't administer pairing`.

Pitfall seen live (#156 leg): `refreshDirectory` ran `devices.list` inside one
`Promise.all` — the refusal rejected the batch and every directory atom stayed
empty (Home: "Employees", zero rows, forever). If a phone ever shows an empty
directory again, suspect an admin-scope call in a shared refresh path first.

## Probing the relay as a paired phone

Token-scope scripts cannot reproduce phone-only failures. To act as a phone:
`POST http://<host>/pair/exchange {"code","name":"probe"}` → `{deviceId,
credential}`, then `new RelayClient({url, device: {deviceId, credential}})`.

## Capturing transient states (~1–2s)

engine-fake `--tick 25` ends a question turn in ~1.5–2s and `plan: tasks` in
~1s — too fast to catch mid-tick with `simctl io` (~0.8–1s per frame). Two
reliable options:

- `plan: slow` — same Tasks card paced ~1.5s/item (~6s total at tick 25):
  plenty of window for a mid-tick still AND a Stop tap.
- Burst loop as a BACKGROUND exec while you drive the UI, pick the right frame:

```sh
for i in $(seq 1 12); do xcrun simctl io $D screenshot /tmp/w-$i.png; done
```

**Verify each still actually shows the intended state** — a simctl screenshot
landed AFTER the turn ended silently captures the done state instead of the
mid-tick one (compare md5s or open the file). The agent screen recording (15fps)
is the primary evidence; the still is a bonus.

## Composer typing & the Stop button (#157/#182 legs)

- Tap coordinates land unreliably a few px off the TextInput — after tapping the
  composer, screenshot to confirm a caret before typing (DM composer input
  ≈ devY 1420; thread composer ≈ devY 1400; retry adjacent px).
- With a hardware keyboard connected (the default), typed text lands with no
  software keyboard; iOS still autocapitalizes the first letter (harmless —
  `plan:` prompt regex is case-insensitive).
- The composer's Stop button replaces Send ONLY while the draft is EMPTY and a
  turn is running. For `plan: slow` (~6s), tap Stop ~2.5s after send — a tap
  at ~4s races the turn end and silently "fails" as a clean completion.
- iOS keyboard Return does NOT send — tap the send arrow.
- iOS autocorrect may rewrite prompts on send — check the sent bubble if the
  text matters.

## Driving the app via the computer `ios` target (preferred over coordinates)

The `computer` tool's `target:"ios"` exposes the running app's React Native
accessibility tree — far more reliable than coordinate taps (which land a few
px off the composer). `inspect`/`query` return `@ref` handles; `act` supports
`press`, `set_text` (fills the composer TextInput directly — no caret
guessing), `increment`/`decrement` (adjustable elements), `scroll`, `scroll_to`.

- It observes the frontmost app of the FIRST booted simulator — boot only the
  device under test or keep it first in `simctl list devices booted`.
- Refs expire on structure changes; re-`query` after each navigation/sheet.
- Element names come from `accessibilityLabel` (e.g. composer chips
  "Fake Reasoning · High", "Just chat", thread rows "<title>, <state>. <body>").

## Model picker / formSheet landmarks (#160 surface)

- Composer model chip opens the ModelPicker `formSheet` (detents [0.62, 1],
  grabber visible). A **"Sheet Grabber" a11y button** toggles the detent —
  `press` it once: value flips "Half screen" → "Expanded". This beats the
  drag workaround for expanding sheets.
- SheetHeader: title "Model" + "Done" button (top-right).
- The **EffortSlider is an adjustable element** ("Reasoning effort") — `act
  increment`/`decrement` steps one rung of THAT model's ladder and the value
  reads back ("Medium" → "High"). The header label above it echoes the same
  rung; with no valid rung it says "Engine default", with no ladder "Not
  adjustable" + "This model has no reasoning control."
- Row details to assert: "<N> reasoning levels" / "No reasoning control" /
  "Not in list", trailing ⚡ = fast, ✓ = current pick. Footer: "Applies from
  the next turn."
- The Fast-mode `Switch` is a plain `checkbox` in the tree (checked=true/false).
- **The turn receipt is the strongest pick-reached-the-engine proof**: the
  reply footer reads "Worked for Ns · <model-id> · <effort>".

## Folder-thread PR card recipe (#159 surface on engine-fake)

- `forge.prs` does `git symbolic-ref HEAD` on the conversation cwd + the
  workspace branch, then `gh pr list --head <branch>` — the fake-gh fixture
  only serves `list-<branch>__….json` files that exist. A "New workstream"
  pick yields `ws/<slug>` → `[]` → NO card. Pick the folder row, then under
  **"No worktree" choose "Edit <seeded-branch> directly"** so HEAD stays on
  the fixture branch (e.g. feat/forge).
- The engine-fake "open a PR" turn raises TWO sequential approval asks
  (`git push`, then `gh pr create`) — approve each through the UI; the reply
  + `PR 12, <title>, Open · checks passed` card follows the second approval.

## Known quirks seen live

- The thread composer model chip has once reported a11y role "slider" with
  increment/decrement instead of "button" (DM + other threads show "button") —
  cosmetic; `press` still opens the picker.
- `simctl io screenshot` (~0.8–1s latency) routinely lands AFTER a ~2s
  engine-fake turn ends — two same-md5 stills means the "mid-turn" frame is
  really the done frame. Don't claim a still shows a transient state without
  opening it.

## RN errors invisible to screenshots

Dev-client console.error toasts truncate ("Encountered two children with the
same ke…"). Pull the full message + key/stack from the device log:

```sh
xcrun simctl spawn $D log show --last 15m --style compact \
  --predicate 'process == "LilOS" AND subsystem == "com.facebook.react.log"'
```

React duplicate-key warnings refire on every offending render — reopening the
component reproduces them (seen live: PlanSheet 'Earlier versions' keyed on
`planId`, identical across versions → 'plan-t1' logged on each sheet open).

## Expected UI landmarks (issue #154 surface)

- Home: large title "LilOS" → offline banner (wifi icon + "Can't reach <Mac>" +
  "Details") → "Employees" rows (orb, name, role, activity) → "Channels".
- Settings tab (bottom-right gear): "PAIRED MAC" section, host row
  `<host> · on this network`, red "Forget this Mac" row → alert
  "Forget this Mac?" → red "Forget" → Welcome screen ("Welcome to LilOS",
  "Get started").
- Tapping an employee opens its real DM (#156); channels still show a "come
  next" alert — not a bug.
- The dev client may show "Downloading 100%" mid-test (Metro fast-refresh) —
  pairing/directory survive; navigate back in.
- iOS autocapitalizes the composer draft — screenshot text differs from typed.

## Asks / approvals on the phone (issue #158 surface)

- `xcrun simctl ui $D appearance dark|light` toggles the theme — grab the dark
  stills with `simctl io` after the switch, no reboot needed.
- One mutating prompt raises SEVERAL sequential approval asks (each mutating
  step: patch/write_file/git): approving an ask resumes the turn until the
  next ask opens. `plan: propose` raises a kind:"plan" ask; engine-fake never
  emits kind:"question" asks — that UI path is unreachable live.
- To answer an open ask as a second device (two-device ACs), from the repo
  root with the relay home at <home>:

```sh
bun -e 'import {RelayClient} from "./packages/client-runtime/src/index";import{readFileSync}from"node:fs";const t=readFileSync("<home>/relay-token","utf8").trim();const c=new RelayClient({url:"ws://127.0.0.1:4577/ws",token:t,client:{name:"mac",version:"0"}});await c.connect();const{asks}=await c.request("asks.list",{});const a=asks.find(x=>x.state==="open");await c.request("asks.respond",{askId:a.id,outcome:"deny"});'
```

  The phone's ask card folds to its receipt on its own within ~1 update.
- `bun` may not be on PATH in agent shells — it's at `~/.bun/bin/bun`.

## Plan & task-list landmarks (issue #182 surface)

- Composer scripts: `plan: tasks` = 3-item working list, ticks then folds
  "Tasks done · 3/3 done" (never asks); `plan: slow` = same paced ~1.5s/item
  for Stop legs; `plan: propose` = 4-step proposal gated on a `plan` ask
  (Approve/Change…/Reject pills; goal + Risks on the waiting card).
- "Change…" prefills the composer `Change the plan: ` + focuses; sending that
  draft answers the ask (outcome change — NO new bubble) and v2 lands with the
  answer folded in as a "Your change: <text>" step (5 steps); v1 folds to
  "Replaced by v2" as its own card ABOVE the turn.
- Waiting plan asks group the thread under "Needs you" on the DM list; it
  moves to "Done" on resolve. Tapping any plan/tasks card opens the Plan
  sheet — newest plan as headline, all earlier versions under "Earlier
  versions", per-step files, Risks.
- `turns.interrupt` mid-run leaves pending/in-progress steps struck-through
  cancelled: "Stopped · n/3" + "You stopped this turn" receipt + "⚠ Stopped."
- AC-5 restore: `⇧⌘H` (Device → Home) then `simctl launch $D com.nuncio.lilos.mobile`
  re-foregrounds the suspended app onto the same thread — plan rows rebuild
  via session.events replay.

## Desktop hygiene before recording

Same as the desktop-app skill: 1024×768 logical screen; dismiss sticky
notification banners by hovering each to reveal its X (`killall
NotificationCenter` doesn't clear them). Keep the Terminal to the left strip so
the Simulator window is never covered.

## Building the app for the simulator (when no DerivedData .app exists)

- `pod` may be missing: `brew install cocoapods` (installs Ruby 4.x as a dep).
- Build with the default Xcode 26.x (`xcode-select -p` → Xcode.app, 26.6).
  **Never set `DEVELOPER_DIR` to the Xcode 27 RC**: the app hasn't adopted
  the UIScene lifecycle (#275), and an iOS-27-SDK build crashes at launch
  (TestFlight build 7 did). If Xcode 26.6 fails with error 70 "iOS 26.5 is
  not installed", fetch the platform once: `xcodebuild -downloadPlatform iOS`
  (~8.5 GB). Then:
  `cd apps/mobile && LANG=en_US.UTF-8 PATH="$HOME/.bun/bin:$PATH" bunx expo run:ios --device <udid>`
  (prebuild + pods + xcodebuild ≈ 15 min).
- The resulting `.app` lands at
  `~/Library/Developer/Xcode/DerivedData/LilOS-*/Build/Products/Debug-iphonesimulator/LilOS.app`
  and can be installed on other booted sims with `xcrun simctl install <udid> <path>`.
- **iOS-27-SDK builds crash on the iOS 27.0 simulator** ("UIScene lifecycle is
  required" — new enforcement). Install/run the same build on the iOS 26.5
  simulator instead (D0B64A8A-D5F1-4668-8FFC-A86B400AF527 is the known-good
  iPhone 17 / iOS 26.5 device on this VM).
- The harness spawns `bun` from `$PATH` for the bundled engine — always export
  `PATH="$HOME/.bun/bin:$PATH"` when launching `apps/harness/src/index.ts`
  directly, or the engine dies with `Executable not found in $PATH: "bun"`.

## Running a custom / cap-less engine through the harness

`LILOS_ENGINE=command` + `LILOS_ENGINE_COMMAND="<argv…>"` (space-split) makes
the harness spawn any engine command; readiness defaults to
`LISTENING (ws://\S+)` on stdout. engine-fake's `serve.ts` takes a repeatable
`--no-cap <id>` flag (since e9072d6):
`bun packages/engine-fake/scripts/serve.ts --port 0 --tick 25 --watch-stdin --no-cap subagents --no-cap background_jobs`
`capOn()` returns false only for caps explicitly set `false`, which both omits
them from `describe` AND skips the scripted event arcs — the clean way to
exercise client-side capability gating (D-#19) end-to-end on the phone. For
arbitrary engines copy `serve.ts` to /tmp and use absolute `.ts` imports.

When restarting the relay manually (e.g. after `scripts/live/*.sh` runs — the
script EXIT trap pkills ALL `apps/relay`/`apps/harness` processes, shared env
included), pass `LILOS_RELAY_TAILSCALE_IP=172.16.4.2` or the phone's pairing
(`ip-172-16-4-2...:4577`) can't connect — the relay binds only 127.0.0.1
without it; the `phoneAccess` setting re-enables the second listener at boot.
Reusing the existing `LILOS_RELAY_HOME`/`LILOS_HARNESS_HOME` keeps the pairing,
employees, and conversation history (relay.sqlite).

Restarting the harness with the same `LILOS_RELAY_URL`, `LILOS_RELAY_TOKEN`
(`cat <relay-home>/relay-token`), `LILOS_HARNESS_HOME` and `LILOS_WORKDIR`
rebinds conversations to a fresh engine session on the next message
(`bindingFor` falls through to `session.start` when `engineRef` is dead).

## Capability plumbing gotcha (LILOS_HIDE_CAPS)

`LILOS_HIDE_CAPS=a,b` only filters the harness's internal `describeResult`
(used by the feed `describe` RPC and `hasCapability`). The relay-facing
welcome the phone gates on (`$welcome.engineHost.capabilities` ←
`session.hello` ← `host.status.capabilities` ← the **unfiltered** probe in
`apps/harness/src/status.ts`) still carries every capability — surfaces stay
visible on the phone under hideCaps. To truly hide surfaces, run a cap-less
engine (above) or an engine that genuinely lacks the caps.

## Seed-world fixture dirs (`live-*-seed.ts` scripts)

- Seeded worlds (`apps/harness/scripts/live-*-seed.ts`) create
  `$TMPDIR/lilos<issue>-XXXX/` and only clean up on SIGINT — killed runs
  leave stale dirs behind. NEVER glob the first `lilos159-*` match to find
  the live gh-fake dir: the live one is the dir the seed printed at launch
  (also `<work>/GH_FAKE_DIR` holds it, and `<work>/gh.log` shows fresh
  `pr list --head ...` lines while the harness is actually probing it).
- Seed scripts spawn relay+harness with `bun` from `$PATH` — on this VM bun
  is `/opt/homebrew/bin/bun`. Launch seeds and RelayClient scripts with
  `PATH="/opt/homebrew/bin:$PATH"`.

## Triggering `turn.completed` on a seeded thread (refresh legs)

- engine-fake's seeded threads arrive in **Needs you** — the opening message
  already ran a turn that is blocked on a chain of asks (patch → write_file
  → git commit). A thread CANNOT complete a new turn until the chain is
  answered. Tapping **Approve** on each ask is the reliable `turn.completed`
  trigger for "does the surface refresh" legs (one Approve per mutating
  step; ~3 asks to Done).

## Driving RN sheets on the simulator

- `scroll` (mouse-wheel) does NOT move a React Native ScrollView inside a
  sheet on this sim — it scrolls the view behind it. Drag inside the sheet
  instead: `left_click_drag` from low on the sheet to higher (e.g. devY
  560 → 420). A drag that starts a pull-to-refresh shows a "Refreshing..."
  bar — harmless, re-screenshot after it settles.

## Employee-helper (@mention → helper's own thread) seeding recipe

- `ensureAgent` uses `employee.profile` (preferred) else `name` as the agent
  id — the engine's mention resolution (`employeeLink`) requires
  `agents.has(employeeRef)` **case-sensitively** plus a *live* session for
  that agent. Seed e.g. `employees.create({name:"Blair", role:"reviewer",
  profile:"blair"})` via the token-scoped RelayClient
  (`<relay-home>/relay-token`, `ws://127.0.0.1:4577/ws`), then send any
  message in that employee's DM first — `session.start` only fires on the
  first message, and mentions resolve against the newest live session.

## Devin Secrets Needed

- `GITHUB_API_KEY` — read GitHub issues/PRs (gh CLI is not authenticated
  without it).
