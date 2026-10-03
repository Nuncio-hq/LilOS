#!/usr/bin/env bash
# Issue #386 live leg: an employee-helper's row in the phone's Subagents
# sheet opens that employee's own thread — against a real relay + harness
# on engine-fake (LILOS_ENGINE=hermes for the real agent on Oscar's Mac).
#
#   bash scripts/live/386.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) and a real
#      harness on the engine you pick — engine-fake by default
#   2. seeds two employees — Ada (the delegator) and Blair (profile
#      reviewer — the helper-employee) — then opens Blair's DM and sends
#      "hello" so her live engine session exists (the fake only links a
#      helper to an employee when that agent has a live session)
#   3. mints a real pairing grant and prints the deep link / simctl command
#   4. keeps both processes alive until Ctrl-C; the phone drives the flow:
#      Home -> Ada -> DM -> send "delegate the summary work to subagents;
#      @reviewer helps" -> the turn's "3 subagents" link -> the Subagents
#      sheet's "Blair · Draft the summary" row -> lands on Blair's thread
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
#   TAILSCALE_IP      static tailnet address the offer advertises (this VM's
#                     stand-in: 172.16.4.2). Leave unset on a Mac running
#                     tailscaled — the real probe advertises the right host.
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

echo "==> live-386: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/386.ts
