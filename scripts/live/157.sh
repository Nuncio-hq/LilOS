#!/usr/bin/env bash
# Issue #157 live leg: the phone's live thread — streaming turns, reply,
# steer (queued), stop, per-thread model, the ⓘ session sheet — against a
# real relay + harness.
#
#   bash scripts/live/157.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) and a real
#      harness on the engine you pick — engine-fake by default
#      (LILOS_ENGINE=hermes for the real agent on Oscar's Mac;
#      HERMES_PROVIDER/HERMES_MODEL select a named provider/model)
#   2. seeds one employee + one recent folder
#   3. mints a real pairing grant and prints the deep link / simctl command
#   4. keeps both processes alive until Ctrl-C; the phone drives the flow:
#      Home -> Ada -> send -> the thread opens and the turn streams live
#      (Thinking..., steps, text) -> reply, steer mid-turn ("Queued · runs
#      next"), Stop ("You stopped this turn"), the model chip, and ⓘ opens
#      the Session sheet
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
#   ENGINE_FAKE_TICK  engine-fake pacing in ms (default 90 — slow enough to
#                     watch the stream land)
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

echo "==> live-157: relay + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/157.ts
