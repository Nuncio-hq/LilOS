---
name: testing-mobile-simulator
description: How to test the LilOS iOS app (apps/mobile) end-to-end in Simulator on this macOS VM — picking the right booted device, simctl app control, the relay, pairing state, cache/offline behavior, and evidence capture quirks.
---

# Testing the LilOS iOS app in Simulator on the macOS VM

apps/mobile is an Expo dev-client app (`com.nuncio.lilos.mobile`) that pairs with a
real relay and renders Home from an on-device cache. Metro must be running for the
JS bundle; the relay provides data.

## Pick the right booted device

Several simulators of the SAME model name (e.g. two "iPhone 17") can be booted;
window titles don't disambiguate them. Find the one that has the app installed:

```sh
xcrun simctl list devices | grep Booted
xcrun simctl listapps <udid> | grep -i lilos   # the device that lists the app owns the window
xcrun simctl get_app_container <udid> com.nuncio.lilos.mobile app
```

## App control (from the shell — drives the visible Simulator window)

```sh
D=<udid>
xcrun simctl terminate $D com.nuncio.lilos.mobile   # true cold start on next launch
xcrun simctl launch   $D com.nuncio.lilos.mobile    # prints new pid
xcrun simctl io $D screenshot /tmp/shot.png          # full-res device still
xcrun simctl openurl  $D 'lilos://pair?host=<h:port>&name=<n>#code=<c>'
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

## Capturing transient states (Working rows, ~1–2s)

engine-fake `--tick 25` ends a question turn in ~1.5–2s — too fast to tap back
and screenshot by hand, and `simctl io` takes ~0.8–1s per frame. Run a burst
loop as a BACKGROUND exec while you drive the UI, then pick the right frame:

```sh
for i in $(seq 1 12); do xcrun simctl io $D screenshot /tmp/w-$i.png; done
```

The agent screen recording (15fps) is the primary evidence; the still is a bonus.

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
- iOS keyboard Return does NOT send the chat composer — tap the send arrow.
- iOS autocorrect may rewrite prompts on send ("readme" → "resume") —
  harmless for the mutating-prompt regex but check the sent bubble if the
  text matters.
- To answer an open ask as a second device (two-device ACs), from the repo
  root with the relay home at <home>:

```sh
bun -e 'import {RelayClient} from "./packages/client-runtime/src/index";import{readFileSync}from"node:fs";const t=readFileSync("<home>/relay-token","utf8").trim();const c=new RelayClient({url:"ws://127.0.0.1:4577/ws",token:t,client:{name:"mac",version:"0"}});await c.connect();const{asks}=await c.request("asks.list",{});const a=asks.find(x=>x.state==="open");await c.request("asks.respond",{askId:a.id,outcome:"deny"});'
```

  The phone's ask card folds to its receipt on its own within ~1 update.
- `bun` may not be on PATH in agent shells — it's at `~/.bun/bin/bun`.

## Desktop hygiene before recording

Same as the desktop-app skill: 1024×768 logical screen; dismiss sticky
notification banners by hovering each to reveal its X (`killall
NotificationCenter` doesn't clear them). Keep the Terminal to the left strip so
the Simulator window is never covered.

## Devin Secrets Needed

None — the relay seeds deterministic demo data; pairing codes are minted locally.
