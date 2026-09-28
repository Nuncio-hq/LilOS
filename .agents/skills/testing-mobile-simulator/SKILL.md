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

- `172.16.4.2` is a local interface IP on this VM — a down relay gives a FAST
  ECONNREFUSED, not a TCP timeout.
- The startup log prints `listening on http://127.0.0.1:4577` — cosmetic: it also
  binds the tailscale IP. If the app won't connect, confirm the `172.16.4.2:4577
  (LISTEN)` line in `lsof -nP -i :4577` before suspecting the app.
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
- Re-pair: `bun /tmp/mint-offer.ts` prints `{"host","code","name"}` →
  `simctl openurl <udid> 'lilos://pair?host=…&name=…#code=…'` → tap "Open" on the
  system dialog. Codes expire in 5 min.
- "Forget this Mac" (Settings tab) deletes the SecureStore key AND the AsyncStorage
  cache; proof = the app drops to the onboarding Welcome screen.

## Expected UI landmarks (issue #154 surface)

- Home: large title "LilOS" → offline banner (wifi icon + "Can't reach <Mac>" +
  "Details") → "Employees" rows (orb, name, role, activity) → "Channels".
- Settings tab (bottom-right gear): "PAIRED MAC" section, host row
  `<host> · on this network`, red "Forget this Mac" row → alert
  "Forget this Mac?" → red "Forget" → Welcome screen ("Welcome to LilOS",
  "Get started").
- Tapping an employee/channel row shows a "come next" alert in this release — not
  a bug.

## Desktop hygiene before recording

Same as the desktop-app skill: 1024×768 logical screen; dismiss sticky
notification banners by hovering each to reveal its X (`killall
NotificationCenter` doesn't clear them). Keep the Terminal to the left strip so
the Simulator window is never covered.

## Devin Secrets Needed

None — the relay seeds deterministic demo data; pairing codes are minted locally.
