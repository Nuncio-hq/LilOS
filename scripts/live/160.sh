#!/usr/bin/env bash
# Issue #160 live leg: the phone's model picker on the engine's real
# models — real provider logos, this model's effort ladder, Fast when it
# has one, the shared hide list, and a pick applying from the next turn.
#
#   bash scripts/live/160.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) and a real
#      harness on the 160-engine shim — engine-fake whose models.list
#      reports REAL provider slugs, so the picker's logos and provider
#      groups are the genuine article (LILOS_ENGINE=hermes for the real
#      engine on Oscar's Mac)
#   2. seeds one employee + one recent folder
#   3. writes xai::fake-small into the shared modelVisibility list — the
#      same KV the Mac's Edit models writes — so AC-1 shows live
#   4. mints a real pairing grant and prints the deep link / simctl
#      command + the un-hide one-liner (settings.changed propagates)
#   5. keeps both processes alive until Ctrl-C; the phone drives:
#      Home -> employee -> DM -> model chip -> picker -> pick -> send
#
# Env:
#   LILOS_ENGINE   default "command" (the 160 shim); hermes for the real
#                  engine — must be on PATH
#   TAILSCALE_IP   static tailnet address the offer advertises (this VM's
#                  stand-in: 172.16.4.2)
#   EMPLOYEE_NAME  default "Ada"
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LANG=en_US.UTF-8

ENGINE="${LILOS_ENGINE:-command}"
if [ "$ENGINE" = "hermes" ]; then
  command -v hermes >/dev/null 2>&1 || {
    echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
    exit 2
  }
fi
export LILOS_ENGINE="$ENGINE"

echo "==> live-160: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/160.ts
