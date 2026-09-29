#!/usr/bin/env bash
# Issue #159 live leg — a thread's pull requests on the phone's own route.
#
#   bash scripts/live/159.sh
#
# Boots a real relay + harness (engine-fake) with `gh` swapped for the
# deterministic fixture script in packages/host/test/fake-gh (serves
# $GH_FAKE_DIR/list-<branch>.json, logs invocations). Seeds a real git repo
# on feat/forge plus a ws/extra branch, then drives `conversations.prs`
# through RelayClient exactly like the phone does.
#
# Asserts: several PRs ordered open->draft->merged->closed with draft flag
# + checks rollup (AC-1/AC-2), a workstream's workspace.branch probed and
# deduped, just-chat -> {prs: []} and non-repo -> error (AC-4), and an
# edited listing appearing on a re-fetch (AC-5's data leg; the phone's
# turn.completed/open triggers are unit-tested).
#
# Prints PASS/FAIL. Exit 0 only on PASS.
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

cleanup() {
  pkill -f "live-159-prs.ts" 2>/dev/null
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  true
}
trap cleanup EXIT

echo "== issue-159 live leg: PRs in DM + thread (engine-fake, fake gh) =="

if bun apps/harness/scripts/live-159-prs.ts; then
  echo "RESULT: PASS"
  exit 0
fi
echo "RESULT: FAIL"
exit 1
