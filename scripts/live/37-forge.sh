#!/usr/bin/env bash
# Issue #37 real leg — forge.pr / forge.comment against real `gh` (comment-only,
# never merge). Run on Oscar's Mac from a LilOS checkout:
#
#   ./scripts/live/37-forge.sh [path-to-checkout] [pr-number]
#
# Examples:
#   ./scripts/live/37-forge.sh .              # comment on this branch's PR
#   ./scripts/live/37-forge.sh ~/src/LilOS 45 # comment on PR #45
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v gh >/dev/null || { echo "FAIL: gh not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "FAIL: gh not authenticated — run: gh auth login"; exit 1; }
exec bun scripts/live/37-forge.ts "$@"
