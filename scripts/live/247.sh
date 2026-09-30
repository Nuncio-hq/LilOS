#!/usr/bin/env bash
# Issue #247 live leg: the phone's prototype polish — headerless Home, the
# Mac in Settings, coloured step diffs, the context meter — against a real
# relay + harness.
#
#   bash scripts/live/247.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) and a real
#      harness on the engine you pick — engine-fake by default
#      (LILOS_ENGINE=hermes for the real agent on Oscar's Mac;
#      HERMES_PROVIDER/HERMES_MODEL select a named provider/model)
#   2. seeds one employee + one recent folder
#   3. mints a real pairing grant and prints the deep link
#   4. keeps both processes alive until Ctrl-C; the phone drives the flow
#      (the checklist prints with the link — every AC in the issue)
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
#   ENGINE_FAKE_TICK  engine-fake pacing in ms (default 90)
#   TAILSCALE_IP      static tailnet address the offer advertises (this VM's
#                     stand-in: 172.16.5.2). Leave unset on a Mac running
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

echo "==> live-247: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/247.ts
