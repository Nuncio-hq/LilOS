#!/usr/bin/env bash
# Issue #132 live leg — on a real Mac, ⌘, opens Settings.
#
#   bash scripts/live/132.sh
#
# What it does:
#   1. builds the desktop payload + boots a dev stack (relay + harness with
#      engine-fake + web) on free ports — no launchd agents are registered
#      by a dev launch, and nothing touches the installed LilOS.app
#   2. launches LilOS (Electron) and presses a REAL ⌘, via System Events —
#      the app's own menu accelerator fires, exactly like a user's keypress
#      (needs Accessibility permission for the terminal on macOS; elsewhere
#      the script clicks the built menu item — same handler)
#   3. asserts the Settings screen rendered, and that "Service Status" still
#      opens its own window
#   4. PASS/FAIL summary on stdout
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

exec bun scripts/live/132.ts "$@"
