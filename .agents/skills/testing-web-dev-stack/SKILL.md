---
name: testing-web-dev-stack
description: How to boot and drive the LilOS web dev stack (relay + harness + engine-fake + vite) in Chrome on this macOS VM for feature/PR evidence — folder picking, checkpoint/rewind flow, fake-engine scripts, and relay DB verification.
---

# Testing the LilOS web dev stack on the macOS VM

Boot the whole slice from the repo root (Bun at `~/.bun/bin`):

```sh
export PATH="$HOME/.bun/bin:$PATH"
LILOS_HOME=/tmp/lilos-rec bun apps/web/dev/stack.ts   # or: cd apps/web && bun run dev
# prints "web http://localhost:5200"; relay :4577, harness feed :4581
```

Env overrides: `LILOS_RELAY_PORT`, `LILOS_FEED_PORT`, `LILOS_WEB_PORT`,
`LILOS_HOME` (fresh dir = fresh company DB), `LILOS_ENGINE` (`fake` default),
`LILOS_HIDE_CAPS` (e.g. `rewind` for the files-only fallback path),
`ENGINE_FAKE_TICK` (ms per streamed step — raise to slow turns for racy checks).

## First-run / seeded employee

- The harness auto-hires engine-fake's `default` profile → employee **"Default"**.
- `/` shows the FirstRun card; "Open DM with Default" sets
  `localStorage["lilos-onboarded"]`. On later loads `/` auto-redirects to
  `/dm/<first-employee-id>` — so after a stack restart just reload `/`.

## Folder pick (composer chip)

- Chip: `[data-ws="folder"]` on the DM-home composer → menu → "Add a folder…"
  → `[data-addfolder]` dialog → type a path in `[data-pathinput]` (host
  `fs.list`-backed; `~` and absolute both browse) → `[data-folderinfo]` shows
  repo/no-repo info → `[data-addbtn]`.
- **Always add folders by ABSOLUTE path.** A `~/x` path is stored verbatim
  (`recent_folders.path`, `conversations.cwd`): host fs calls expand `~`, but
  the #134 checkpoint store's `git` spawn gets `cwd="~/x"` and fails
  `ENOENT: posix_spawn 'git'` — every user message then gets `checkpoint=NULL`
  and Rewind silently reports only "N messages dropped" (no file restore).

## Rewind-to-here (#134) landmarks

- One `Rewind to here` checkpoint trigger per user message: `[data-rewind]`,
  always rendered (hover adds tooltip "Undo files + conversation back to
  before this message"); disabled while a turn runs.
- Success note in-thread: `Rewound to before your message — N messages
  dropped, files restored to the earlier checkpoint.` (the files suffix is
  absent when no checkpoint was stamped — silent no-restore).
- The picked message's text reseeds the composer textarea.
- Engine-fake reply scripts: first turn "Short answer: …", follow-ups
  "Noted. Plan for this session now: … 2. <prompt>"; send `recall:` to get
  "I remember N earlier turns: …" — proves the engine dropped rewound turns.
- Verify in `$LILOS_HOME/relay.sqlite`: `messages.rewound`,
  `messages.checkpoint` (user rows), `conversations.cwd`,
  `recent_folders.path`. Read with `bun -e '…new Database(path,{readonly:true})'`.

## Workbench (Focus mode)

- First send navigates to `/dm/<emp>/<conv>/focus`; the header's panel toggle
  opens the Workbench. The Files tab (`fs.tree`) re-fetches on panel mount —
  to show a mid-session file change, toggle the panel closed/open.
- engine-fake never touches the filesystem — simulate "agent writes" via
  shell (`echo > file`, `rm`, edit) between turns; checkpoint restore then
  removes/reverts them.

## Desktop hygiene

- Quit overlapping windows: `osascript -e 'quit app "Simulator"'`.
- Size Chrome: `osascript -e 'tell application "System Events" to tell
  process "Google Chrome" to set position of window 1 to {0,25}' -e '…set
  size of window 1 to {1024,742}'`.
- Full-screen PNGs: `screencapture -x /tmp/shot.png` (retina resolution).

## Devin Secrets Needed

None — engine-fake is deterministic and local.
