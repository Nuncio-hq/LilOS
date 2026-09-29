#!/usr/bin/env bash
# Issue #238 live leg: the phone's folder browser — browse the Mac's home,
# "Found on this Mac", Use -> recents -> a session that runs in the picked
# folder — against a real relay + harness.
#
#   bash scripts/live/238.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4583) and a real
#      harness on the engine you pick — engine-fake by default
#      (LILOS_ENGINE=hermes for the real agent on Oscar's Mac;
#      HERMES_PROVIDER/HERMES_MODEL select a named provider/model)
#   2. seeds one employee + a demo tree under ~/Documents/lilos-live-238
#      (two git repos + a plain dir — real folders the sheet will list)
#   3. mints a real pairing grant and prints the deep link / simctl command
#   4. keeps both processes alive until Ctrl-C; the phone drives the flow:
#      Home -> Ada -> folder chip -> "Other folder on this Mac…" -> the
#      Mac's home lists, tap into ~/Documents/lilos-live-238 -> Use ->
#      the pick lands on the composer -> send -> the session runs there
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
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

echo "==> live-238: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/238.ts
