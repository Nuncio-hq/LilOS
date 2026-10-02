#!/usr/bin/env bash
# Issue #108 live leg: post a "Review comments on the diff" message mid-turn
# and check the harness routes it as a steer (engine declares `steer`) or
# queues it as the next prompt — the same rule the composer uses (AC-3).
#
#   bash scripts/live/108.sh
#
# What it does:
#   1. launches a real relay + real harness on the engine you pick —
#      engine-fake by default, LILOS_ENGINE=hermes for the real agent
#   2. opens a DM conversation in a seeded git folder (uncommitted changes)
#   3. starts a slow turn, then posts the diff-comments message mid-turn
#   4. watches the engine feed: `turn.steered` = steered into the running
#      turn, a turn after the first settles = queued as the next prompt
#   5. answers any approval asks and prints a PASS/FAIL summary
#
# Env:
#   LILOS_ENGINE      default fake; set hermes for the real engine
#   HERMES_PROVIDER   hermes provider when ENGINE=hermes
#   HERMES_MODEL      hermes model when ENGINE=hermes
#   LILOS_RELAY_PORT  default 4577
#   LILOS_FEED_PORT   default 4581
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

echo "==> live-108: relay + harness (engine=${ENGINE})"
exec bun scripts/live/108.ts
