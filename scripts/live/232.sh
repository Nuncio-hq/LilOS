#!/usr/bin/env bash
# Issue #232 live leg: native macOS window chrome on a real Mac.
#
#   bash scripts/live/232.sh
#
# What it does:
#   1. builds + installs LilOS.app via `bun run app:local` (ad-hoc signed,
#      real Hermes engine) — the exact app Oscar runs
#   2. opens it and prints the manual checklist for the window chrome ACs
#
# Try, in order (≈2 min):
#   - AC-1  No title bar: traffic lights sit inside the sidebar header,
#           level with the company name. Nothing overlaps them at any
#           window width.
#   - AC-2  The sidebar is translucent — move the window over a busy
#           desktop / change the wallpaper / toggle macOS Dark Mode and
#           watch the sidebar react; the main pane stays solid.
#           Also flip the app's own theme (sun/moon/monitor toggle, bottom
#           of the sidebar): window chrome follows the APP theme, so the
#           sidebar stays readable in every combination.
#   - AC-3  Drag the window by the sidebar header row or any panel header;
#           double-click the sidebar header to zoom. Buttons and inputs in
#           those strips still click normally.
#   - AC-4  Enter full screen (green light / Control-Cmd-F): lights hide
#           and the sidebar fills to the top with no empty strip. Leave
#           full screen and both return.
#   - AC-5  Quit and relaunch LilOS (or hide ~/.lilos) so the first-run
#           status window shows: same treatment — lights inset, vibrancy,
#           draggable top strip. Then open the app in a normal browser tab
#           (`bun run dev` in apps/web): unchanged, normal margins.
#
# Exit code: the script exits 0 once LilOS is installed and the relay
# answers; the chrome checks themselves are eyes-on (native chrome cannot
# be driven by synthetic input — verified in e2e/ac-232 via real input).
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

if [ "$(uname)" != "Darwin" ]; then
  echo "SKIP: native window chrome is a macOS leg"
  exit 2
fi

bun run app:local

cat <<'CHECKLIST'

LilOS.app is installed and running — try the window chrome:

  AC-1  no title bar; traffic lights inset beside the company name
  AC-2  sidebar shows the desktop through it (move over the wallpaper /
        toggle Dark Mode); flip the app theme too — window follows it
  AC-3  drag by the sidebar header / panel headers; double-click = zoom;
        buttons inside those strips still work
  AC-4  full screen: lights + top gap gone; exit restores both
  AC-5  fresh install shows the same chrome on the status window;
        a plain browser tab is unchanged

PASS = all of the above hold on this Mac.
CHECKLIST
