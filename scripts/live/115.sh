#!/usr/bin/env bash
# Issue #115 live leg: hire/edit/remove employees through the real relay +
# harness against a REAL `hermes serve` — the same wire calls the shipped
# app's HireDialog/EditEmployeeDialog make:
#
#   agents.list (Use profile) → agents.create + employees.create +
#   channels.openDm (New profile hire) → duplicate-name rejection →
#   employees.update (Edit) → employees.remove (Remove; DM channel deleted,
#   engine profile kept) → `hermes profile list` cross-check.
#
# Driven by apps/harness/scripts/employees-demo.ts which boots its own
# relay+harness on free ports, so it can run beside the dev stack or the
# packaged app.
#
# profiles.* are file operations on `~/.hermes` — they run for real whether
# or not an LLM provider is signed in (no session turn is made). When
# HERMES_PROVIDER + HERMES_MODEL are set the harness pins them on `hermes
# serve` (Oscar's Mac: e.g. the qwen/codex provider); unset, hermes uses its
# ambient profile config and the run is labeled "ambient".
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/115.sh
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

command -v hermes >/dev/null 2>&1 || {
  echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
  exit 2
}

LABEL=ambient
if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  LABEL="live (${HERMES_PROVIDER}/${HERMES_MODEL})"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"
# The demo harness defaults to feed port 4581 — the packaged app's launchd
# harness may already hold it, so move to a free one.
export LILOS_FEED_PORT="${LILOS_FEED_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"

echo "== issue-115 live leg: engine=hermes label=${LABEL} =="
OUT=$(bun apps/harness/scripts/employees-demo.ts --engine hermes)
echo "$OUT"

SLUG=$(echo "$OUT" | sed -n 's/^PROFILE_SLUG=//p' | tail -1)
if [ -z "$SLUG" ]; then
  echo "RESULT: FAIL — demo did not report a created profile"
  exit 1
fi

# The profile the demo created must be a real Hermes profile, and it must
# still be there after the LilOS employee was removed (D-#29).
if hermes profile list 2>/dev/null | grep -q "$SLUG"; then
  echo "RESULT hermes-profile: PASS — \`hermes profile list\` still shows $SLUG"
else
  echo "RESULT hermes-profile: FAIL — $SLUG missing from hermes profile list"
  exit 1
fi

# The mixed-case display name must have landed as its lowercase slug too.
CASE_SLUG=$(echo "$OUT" | sed -n 's/^PROFILE_CASE=//p' | tail -1)
if [ -n "$CASE_SLUG" ] &&
  hermes profile list 2>/dev/null | grep -q "$CASE_SLUG"; then
  echo "RESULT hermes-profile-case: PASS — \`hermes profile list\` shows $CASE_SLUG"
else
  echo "RESULT hermes-profile-case: FAIL — $CASE_SLUG missing from hermes profile list"
  exit 1
fi

if echo "$OUT" | grep -q "RESULT AC-4: PASS" &&
  echo "$OUT" | grep -q "RESULT AC-3-reject: PASS" &&
  echo "$OUT" | grep -q "RESULT AC-3-case: PASS" &&
  echo "$OUT" | grep -q "RESULT AC-3-case-dup: PASS" &&
  echo "$OUT" | grep -q "RESULT AC-2-dm: PASS"; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
