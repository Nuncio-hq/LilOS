---
name: testing-desktop-app
description: How to test the packaged LilOS desktop app (LilOS.app) end-to-end on this macOS VM — clean-state resets, launchd agents, first-run gate, DM round-trip, and where evidence lives.
---

# Testing the packaged LilOS desktop app on the macOS VM

The packaged app (`LilOS*.app`, ad-hoc signed dev build) registers two launchd
agents at launch: `com.nuncio.lilos.relay` (ws relay, `http://127.0.0.1:4577/healthz`)
and `com.nuncio.lilos.harness` (engine feed, port 4581). It bundles
`lilos-relay`/`lilos-harness`/`lilos-engine-fake`/`lilos-svc` in `Contents/MacOS`
and the web UI in `Contents/Resources/app/web`.

## Reset to a true first-run state

```sh
killall LilOS 2>/dev/null
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.relay" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.harness" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.nuncio.lilos.*.plist
rm -rf ~/Library/Application\ Support/LilOS   # Electron userData (localStorage: lilos-onboarded gate)
rm -rf ~/.lilos                             # relay home: relay-token + relay.sqlite + harness state
curl -s -m2 http://127.0.0.1:4577/healthz   # must fail (exit 7)
```

Omitting `~/.lilos` leaves stale employees/DM history — the FirstRun card still
shows (it is gated on `localStorage["lilos-onboarded"]`, cleared with the app
support dir) but the DM thread is polluted with old messages.

## Expected flow on an ad-hoc build

`lilos-svc` detects the ad-hoc signature and uses the `launchctl bootstrap`
backend (writes `~/Library/LaunchAgents/*.plist` with absolute `Program`, not
SMAppService). Agents report `enabled` immediately — the **status window with
the approval guide only appears on Developer ID builds** where SMAppService can
return `requiresApproval`. On ad-hoc builds the app window opens directly;
approval evidence is the "LilOS(-vN) — 2 items" row under System Settings →
General → Login Items & Extensions → "Allow in the Background" (toggle ON).
Open the pane with:

```sh
open "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
```

## UI landmarks

- FirstRun card (fresh state): "Welcome to LilOS" → rows settle to
  "Connected · local relay" and "Default · ready" (~1.4 s) → button
  "Open DM with Default".
- DM composer placeholder: "New session with Default…". Enter sends;
  engine-fake replies in-thread within seconds (generic prompts get the
  "Short answer:" fallback script with collapsed tool steps).
- Service logs: `/tmp/com.nuncio.lilos.{relay,harness}.{stdout,stderr}.log`;
  app log: `~/Library/Application Support/LilOS/logs` (when present); also
  `log show --last 2m --predicate 'process CONTAINS "lilos"'`.

## Desktop cleanup before recording

- Stacked "App Background Activity" banners persist: hover a banner to reveal
  its X and click it (`killall NotificationCenter` alone does not clear them).
- Hide unrelated windows (e.g. iOS Simulator) via
  `osascript -e 'tell application "System Events" to set visible of process "Simulator" to false'`.
- Screen is small (1024×768 logical): windows larger than that get clamped —
  fine, but verify the target window is fully on screen before capturing.
- Full-screen captures: `screencapture -x /path.png` works from the shell
  (1600×1200 retina PNGs).

## Driving the app window (computer tool, macOS target)

- The macOS accessibility target does not match the app by name — use the
  **pid**: `pgrep -x LilOS`, then pass it as `app` in query/act calls.
  Electron web content (buttons, menus, text) is exposed in the app's tree.
- AX `press` on web dropdown chips (Base UI menus) often does NOT open the
  menu — use real `left_click` at the control's screen coordinates instead;
  verify with a screenshot.
- First DM open on a fresh state triggers macOS TCC prompts ("LilOS would
  like to access files in your Desktop/Documents folder") because the host
  API's `git.discoverRepos` scans ~/Desktop, ~/Developer, ~/Documents,
  ~/repos. Click **Allow** on each — expected behavior, and good evidence
  the host API is really scanning local dirs.
- The native folder dialog (Electron `dialog.showOpenDialog`) is a real
  NSOpenPanel: `key cmd+shift+g` opens "Go to Folder", `type` the absolute
  path, `Return` selects it in its parent listing, then click the **Open**
  button (bottom-right) to confirm.
- Packaged harness default workdir is `~/.lilos/harness/work` (NOT
  `~/.lilos/work`): a no-folder session posts
  `No folder: working in ~/.lilos/harness/work`. engine-fake's follow-up
  reply echoes `I'm in `<cwd>` on ⎇ `work/<agent>-<session>`` — the ⎇ name
  is the fake's synthetic session branch; the real git branch (e.g.
  `trunk`) is asserted on the thread header's green workspace badge.

## Devin Secrets Needed

None for the packaged-app flow — engine-fake is bundled and deterministic.
