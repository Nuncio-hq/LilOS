#!/usr/bin/env bash
# Issue #161 live leg: Expo push notifications — relay fan-out, Expo stub
# collector/forwarder, a scripted stub-phone pairing + registering for real,
# and the deep link for a physical iPhone.
#
#   bash scripts/live/161.sh
#
# What it does:
#   1. launches a real relay (LILOS_RELAY_PORT, default 4577) pointed at a
#      local Expo stub (LILOS_EXPO_STUB_PORT, default 4610) instead of
#      exp.host, and a real harness on the engine you pick — engine-fake by
#      default (LILOS_ENGINE=hermes for the real agent)
#   2. the stub prints every push payload and FORWARDS it to the real
#      exp.host — a paired iPhone buzzes for real; LILOS_EXPO_DRYRUN=1 keeps
#      it fully local (receipts faked ok)
#   3. a stub device pairs (pairing.offer → /pair/exchange), registers a
#      fake token with push.register, then drives every transition: an
#      approval ask (needs-you), approving it (done), a refusal (failed),
#      and push.visibility suppression of a thread it reports open
#   4. prints a second pairing offer — the lilos:// deep link for the
#      physical phone — and stays up until Ctrl-C
#
# Env:
#   LILOS_ENGINE         default fake; hermes for the real engine
#   ENGINE_FAKE_TICK     engine-fake pacing in ms (default 150)
#   TAILSCALE_IP         tailnet address the offer advertises (this VM's
#                        stand-in: 172.16.4.2). Leave unset on a Mac running
#                        tailscaled — the real probe advertises the right host.
#   LILOS_EXPO_DRYRUN    =1 → the stub answers ok without calling exp.host
#   EMPLOYEE_NAME        default "Ada"
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

echo "==> live-161: relay + expo-stub + harness (engine=${ENGINE}); Ctrl-C to stop"
exec bun scripts/live/161.ts
