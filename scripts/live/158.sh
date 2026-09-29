#!/usr/bin/env bash
# Issue #158 live leg: approve / deny an agent's pending ask from the phone —
# thread approval card, Activity approvals sheet, Home "Needs you" accessory —
# with haptics and the resolved receipt, against a real relay + harness.
#
#   bash scripts/live/158.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) and a real
#      harness on the engine you pick — engine-fake by default
#      (LILOS_ENGINE=hermes for the real agent on Oscar's Mac;
#      HERMES_PROVIDER/HERMES_MODEL select a named provider/model)
#   2. seeds one employee + one recent folder
#   3. mints a real pairing grant and prints the deep link / simctl command
#   4. keeps both processes alive until Ctrl-C; the phone drives the flow:
#      Home -> Ada -> send "fix the readme" -> the approval card lands with
#      Approve/Deny pills and the Needs-you bar appears; approve resumes the
#      turn, deny ends it with a "You denied" receipt. A "plan: propose"
#      prompt raises a plan ask (approve/reject on the wire). Answering on
#      the Mac folds the phone's card within one update.
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
#   ENGINE_FAKE_TICK  engine-fake pacing in ms (default 150 — slow enough to
#                     catch the ask while it's open)
#   TAILSCALE_IP      static tailnet address the offer advertises (this VM's
#                     stand-in: 172.16.4.2). Leave unset on a Mac running
#                     tailscaled — the real probe advertises the right host.
#   EMPLOYEE_NAME     default "Ada"
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LANG=en_US.UTF-8

ENGINE="${LILOS_ENGINE:-fake}"
if [ "$ENGINE" = "hermes" ]; then
  command -v hermes >/dev/null 2>&1 || {
    echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
    exit 2
  }
fi

echo "==> live-158: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/158.ts
