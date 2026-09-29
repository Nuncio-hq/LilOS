---
name: testing-desktop-app
description: How to test the packaged LilOS desktop app (LilOS.app) end-to-end on this macOS VM — clean-state resets, launchd agents, first-run gate, DM round-trip, and where evidence lives.
---

# Testing the packaged LilOS desktop app on the macOS VM

The packaged app (`LilOS*.app`, ad-hoc signed dev build) registers two launchd
agents at launch: `com.nuncio.lilos.relay` (ws relay, `http://127.0.0.1:4577/healthz`)
and `com.nuncio.lilos.harness` (engine feed, port 4581). It bundles
`lilos-relay`/`lilos-harness`/`lilos-engine-nous`/`lilos-engine-fake`/`lilos-svc` in `Contents/MacOS`
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
- Careful WHERE you click a notification banner: clicking the banner body
  (not the X) launches the underlying app — the Tahoe "See what's new"
  banner opens the **Tips** app slideshow overlay. If it opens, quit it via
  `osascript -e 'tell application "Tips" to quit'`. The X sits at the
  banner's top-LEFT corner.
- Hide unrelated windows (e.g. iOS Simulator) via
  `osascript -e 'tell application "System Events" to set visible of process "Simulator" to false'`.
- Screen is small (1024×768 logical): windows larger than that get clamped —
  fine, but verify the target window is fully on screen before capturing.
- Full-screen captures: `screencapture -x /path.png` works from the shell
  (1600×1200 retina PNGs).

## Driving the app window (computer tool, macOS target)

- The macOS accessibility target does not match the app by name — use the
  **pid**: `pgrep -x LilOS`, then pass it as `app` in query/act calls.
  Re-resolve the pid after every (re)launch — it changes and stale pids
  return "did not answer accessibility requests". Electron web content
  (buttons, menus, text) is exposed in the app's tree.
- AX `press` on web dropdown chips (Base UI menus) often does NOT open the
  menu — use real `left_click` at the control's screen coordinates instead;
  verify with a screenshot.
- `git.discoverRepos` is lazy since #113: it only runs when the
  Add-folder dialog opens, never on DM mount — so a packaged-app DM open
  produces NO TCC prompt. Since #208 the dialog is LilOS's own in-app
  `AddFolderDialog` (`[data-addfolder]`) on desktop too — there is no
  `lilos:pick-folder` / `dialog.showOpenDialog` path anymore. A TCC
  prompt DOES appear right after clicking Add a folder: the dialog
  starts on `~/Desktop` and `fs.list` / `git.discoverRepos` touch the
  protected roots (~/Desktop, ~/Documents) — "access files in your
  Desktop folder". Denying skips that root; the dialog stays usable.
  Strong laziness proof: `tccutil reset SystemPolicyDesktopFolder
  com.nuncio.lilos` (+ DocumentsFolder), reload the DM, then
  `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select
  client,service from access where client like '%lilos%'"` must stay
  EMPTY until Add a folder is clicked.
- The composer's 📎 "Attach files" button sits immediately LEFT of the
  folder chip — a misclick opens Electron's FILE picker (dirs grayed,
  Open navigates into folders instead of selecting, no New Folder
  button). The real Add-folder dialog is in-app: "Found on this Mac"
  chips, a path field with breadcrumb + folder listing, a folder status
  card, Cancel/Add folder. If a macOS panel opens you hit the wrong
  control: Cancel and click the chip's center, not its left edge.
- Text inputs in the Electron webview (and Chrome): `ctrl+a` is the Emacs
  "move to line start", NOT select-all — focus the field first, then use
  `cmd+a` (or triple-click inside the field) before retyping.
- The TCC prompt on Add a folder can be a QUEUE: Desktop first, then
  Documents (~1 s apart) — answer each as it appears; denying only resets
  what you deny (`tccutil reset SystemPolicyDesktopFolder` clears just
  Desktop; the Documents grant survives).
- `test-results/` is wiped by concurrent e2e/vitest runs (`rm -rf` during
  setup) — stage curated screenshots in /tmp or ~/screenshots and copy into
  `test-results/` only at the end; keep a mirror copy elsewhere.
- Packaged harness default workdir is `~/.lilos/harness/work` (NOT
  `~/.lilos/work`): a no-folder session runs there as a plain chat — no
  `No folder` note and no header chip (#196). engine-fake's follow-up
  reply echoes `I'm in `<cwd>` on ⎇ `work/<agent>-<session>`` — the ⎇ name
  is the fake's synthetic session branch; the real git branch (e.g.
  `trunk`) is asserted on the thread header's green workspace badge.

## Devin Secrets Needed

None for the packaged-app flow — engine-fake is bundled and deterministic.
