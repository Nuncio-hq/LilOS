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

- The tailscale stand-in IP VARIES per VM AND per interface (seen on both
  `lo0` and `en0`) — find it with `ifconfig | grep 'inet 172\.'` (this VM:
  en0 172.16.4.2). A wrong IP makes `pairing.offer` fail
  `tailscale_unavailable` (the bind fails, not the probe); 127.0.0.1 does
  NOT work (EADDRINUSE against the primary bind).
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
- `simctl uninstall` + reinstall resets notification authorization to
  undetermined but the SecureStore pairing SURVIVES (no re-pair needed);
  AsyncStorage prefs (e.g. push kind toggles) do NOT survive.

## Notification-permission states (#161)

`xcrun simctl privacy` has NO notifications service — drive the states via
the UI instead:

- **undetermined**: a fresh install has it until the app first registers
  (paired + online foreground — `push.ts` asks there, not at cold boot).
  The Settings "Allow notifications · Ask" row shows only while
  undetermined and fires the real OS prompt; capture it before the app
  reaches the paired/online register path, or `simctl uninstall` +
  reinstall the DerivedData `.app` and stay on the onboarding stack.
- **denied**: answer "Don't Allow" on the OS prompt (or Settings → Apps →
  LilOS → Notifications off) → the Settings row turns red "Notifications
  are off" + guidance + Fix. `Linking.openSettings()` lands on the iOS
  Settings ROOT (with a back-to-app link) on iOS 26.5 — then Apps → LilOS
  → Notifications to flip it manually.
- **granted**: after allowing, the section shows only the four kind
  toggles. A toggle persists via AsyncStorage — cold restart proves it;
  `simctl uninstall` wipes it back to all-ON.
- The sim canNOT fetch an Expo push token without an `eas.projectId`
  (`getExpoPushTokenAsync` throws → `register()` no-ops silently) — relay
  side is proven via `scripts/live/161.sh`'s stub phone, real-device
  delivery is a physical-iPhone leg.

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

## Pointing the dev client at a DIFFERENT project's bundle

`com.nuncio.lilos.mobile` is shared by apps/mobile AND prototype/mobile —
and the dev client always reloads the bundle URL it last used:
the `expo-development-client/?url=` deep link, the dev menu's "Configure
Bundler" form, and cold restarts did NOT switch it (#259 leg). The
reliable trick: **run the other project's `expo start --dev-client` on
the SAME port (8081)** — the client fetches whatever that port serves:

```sh
kill $(lsof -ti :8081)                              # stop the running project's Metro
cd prototype/mobile && bunx expo start --dev-client --port 8081
xcrun simctl terminate $D com.nuncio.lilos.mobile
xcrun simctl launch    $D com.nuncio.lilos.mobile   # boots the OTHER project's bundle
```

Restore by restarting the original project's Metro on 8081. Killing Metro
does NOT uninstall the app — only JS serving stops.

## Code-block / table evidence techniques (#259/#306 legs)

- **In-progress `…` header**: engine-fake streams word-by-word at tick 25 —
  a ~700-word reply takes ~7s and each fenced block sits `closed:false`
  ~0.3–0.6s while its code streams. The in-progress block is the LAST
  rendered element, just above the composer — burst `simctl io screenshot`
  right after send (~1s/frame over the window) catches it.
- **Inner horizontal ScrollView** (code lines, wide tables): the a11y
  `scroll` op degrades to a coordinate swipe that often moves nothing
  ("container is at its end"). A coordinate `left_click_drag` leftward ON
  the text rows works — multi-row grids take it first try; single-line
  blocks may need 2–3 tries with slight vertical drift. Proof of scroll:
  the tail token appears while surrounding prose stays fixed.
- **Clipboard proof**: host `pbpaste` reads the simulator pasteboard —
  after a "Copy code" tap it returns the block text byte-for-byte, stronger
  than the ~1.5s "Copied" label a `simctl io` still usually misses (the
  a11y tree does catch the flip if queried immediately).

## Pixel-verifying layout claims (e.g. aligned column dividers)

When a fix is about pixel-level layout, don't just eyeball the still —
scan it with PIL. Sim screenshots are full device res (1206×2622). Recipe:

1. Find row bands by locating horizontal separator rows: y's where >90%
   of x in the table area are one near-uniform panel gray.
2. Per band, an x is a "separator column" when ≥half its pixels are the
   border tone (light ≈ `232,232,237` on panel `242,242,247`;
   dark ≈ `38,38,39`/`45,45,45` on bg `28,28,30`).
3. Compare peak x lists across bands — identical = aligned.

Traps: (a) a muted header band IS separator-gray everywhere, so probe
candidate x's with a vertical profile instead of a band-wide scan;
(b) verify text styling the same way — `**bold**` stems measure ~4–5px vs
~3px regular, mono vs proportional shows in single glyph bboxes, and
COLOR needs its own check: a `text-accent-text` span can render black
while the font applies.

When a fix "doesn't take" in the render, first rule out a stale bundle:
`tail -f` the Metro log through a `simctl terminate`+`launch` — a new
`iOS Bundled …ms (N modules)` line is the app fetching; then fetch the
bundle yourself (`curl "http://localhost:8081/apps/mobile/index.bundle?
platform=ios&dev=true&minify=false"` — paths resolve from the REPO root
in this monorepo, not the app dir) and grep for the fix signature. If the
served code is right but pixels are wrong, the bug is real, not env.

## Stale engine-fake: fixture changes need a HARNESS restart, not an app reload

The live env's `engine-fake` runs as a subprocess the harness spawns at
startup — it snapshots the fixture source at spawn time. A commit that
changes the fixture (e.g. adding `**`/`` ` `` markers to a markdown
sample) does NOT reach replies until the harness is restarted —
`simctl terminate`+`launch` of the app only refetches the JS bundle.
Symptom that cost two legs: cells rendered plain because the stored
reply text had no markers at all — the renderer was never at fault.

Diagnosis path: (1) a temp `console.warn` probe in the component logs the
text it actually receives (` WARN <msg>` in the Metro log); (2) read the
STORED message — get `$LILOS_RELAY_HOME` via `ps eww <relay-pid>`, then
`sqlite3 relay.sqlite "SELECT text FROM messages WHERE ..."` — if storage
lacks the markers, the fault is upstream of the app; (3) diff the stored
text against `git log -p` on the fixture to spot the stale revision.

Restart: `ps eww <harness-pid> | tr ' ' '\n' | grep LILOS` captures its
env, `kill <harness-pid>` (relay keeps running — pairing/messages survive
in its sqlite), relaunch `bun apps/harness/src/index.ts` with the same
vars (bun needs an explicit PATH entry under `env`). The app reconnects
by itself; resend the `md:` command for a reply on the fresh fixture.

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
- The dev client "!, Open debugger to view warnings." pill can cover
  bottom-screen controls (a11y `press` refuses as "covered") and doesn't
  always auto-dismiss — tap its X at the right edge, or tap the control by
  coordinates.
- A sent bubble can keep a stale "Queued · runs next" caption while the
  reply below is already streaming — cosmetic label lag, not a send
  failure; don't mistake it for a stuck turn.

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
  (prebuild + pods + xcodebuild ≈ 15 min). The `LANG` is load-bearing:
  agent shells run `LANG=""` and brew's Ruby 4 crashes `pod install` with
  `Unicode Normalization not appropriate for ASCII-8BIT` — looks like a
  CocoaPods bug, is purely the missing UTF-8 locale.
- `expo run:ios` keeps the Metro dev server alive inside the same process
  after install+launch — leave that background shell running or the dev
  client shows "Cannot connect to Metro". Reinstalling the same `.app`
  (`simctl install` + `launch`) still serves the freshest JS from that
  Metro — handy for temp-patch captures without a rebuild.
- The resulting `.app` lands at
  `~/Library/Developer/Xcode/DerivedData/LilOS-*/Build/Products/Debug-iphonesimulator/LilOS.app`
  and can be installed on other booted sims with `xcrun simctl install <udid> <path>`.
- After `xcodebuild -downloadPlatform iOS` finishes, verify the platform
  landed before rebuilding:
  `xcodebuild -workspace apps/mobile/ios/LilOS.xcworkspace -scheme LilOS -showdestinations`
  — the target sim (e.g. iPhone 17 OS:26.5) appears as an `iOS Simulator`
  destination. With Pods + DerivedData already in place, `expo run:ios
  --device <udid>` then builds in ~2–3 min, not ~15.
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

## Pair-prompt ordering on iOS 26.5 (observed #386)

The "Open in LilOS?" sheet and the local-network prompt do NOT always
stack: tapping "Open" can render the "You're connected" screen FIRST,
with the local-network prompt popping on top a beat later. Sequence that
works: tap Allow on the local-network prompt whenever it appears, dismiss
the dev-client "Open debugger to view warnings." pill via its X at the
right edge (it covers the bottom Continue button — an a11y `press` on
Continue is refused as "covered"), then tap Continue. The pill reappears;
re-dismiss.

## Seeded world survives pair-code expiry

`pairing.offer` codes last ~5 min but the scripts/live/NNN.sh stack
(relay + harness + seeded employees/sessions) keeps running. Mint a fresh
offer against the RUNNING relay — get `LILOS_RELAY_HOME` from
`ps eww <relay-pid>`, read `<home>/relay-token`, and `pairing.offer` via a
token-scoped RelayClient — instead of restarting the script (a restart
reseeds a new world and invalidates already-woken helper sessions).

## Subagents sheet a11y landmarks (#181/#319/#386 surfaces)

- Turn card link: `button "N subagents[, M running][, K failed], open
  subagents"` — the a11y label of the "3 subagents · 1 failed · Open" line.
- Sheet: `SheetHeader "Subagents"`; groups render as labels `"Running ·
  n"` / `"Finished · n"` (each group omitted when empty).
- Employee-helper row a11y label: `"<Name>, <job title>, <Done|Working|
  Failed>"` (e.g. `"Blair, Draft the summary, Done"`); visually it carries
  an Orb and a bold `"<Name> · "` title prefix — the cues that
  `employee.threadId` resolved and the row will navigate. A row WITHOUT
  the orb/name prefix falls back to the helper-brief SubagentSheet — that
  is the regression signal for issue #386.
- Verifying a resolved link: the row tap should pop the sheet and land on
  a Thread whose header is the employee's conversation title with that
  employee's composer ("Reply to <Name>"); landing on a "Brief / steps /
  Report" layout means `threadId` never resolved (check the relay
  conversation's `engineRef` vs the subagent's `sessionRef`).

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
