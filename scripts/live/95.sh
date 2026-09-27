#!/usr/bin/env bash
# Issue #95 live leg — engine start failures read plainly.
#
#   bash scripts/live/95.sh
#
# Runs the REAL harness launcher path against the real `hermes` on this Mac
# (apps/harness/scripts/live-95-engine-reasons.ts). No stub engine:
#
#   - Hermes older than MIN_HERMES_VERSION (Oscar's personal Mac: 0.20.2)
#     must produce exactly:
#       Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run `hermes update`.
#     as a fatal verdict — the harness does not retry.
#   - Hermes >= the minimum boots the adapter for real (`hermes serve` runs;
#     pass HERMES_PROVIDER / HERMES_MODEL to ride a specific provider).
#
# AC-2 (a device policy SIGKILLing the engine child) cannot be reproduced
# live — it is covered by e2e/ac-95-engine-reasons.spec.ts, whose stub
# HERMES_BIN `kill -9`s itself.
#
# Prints PASS/FAIL. Exit 0 only on PASS.
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

exec bun apps/harness/scripts/live-95-engine-reasons.ts
