#!/usr/bin/env bash
# Issue #181 live leg — subagents & background jobs in a mobile thread.
#
#   bash scripts/live/181.sh                       # engine-fake: the full flow
#   LILOS_ENGINE=hermes bash scripts/live/181.sh   # hermes leg (caps + whatever rows the engine produces)
#
# engine-fake (default): asserts `subagents` + `background_jobs` capabilities
# on the engine describe AND the relay welcome (the phone's D-#19 gate), a
# `delegate` turn folding three helpers done/failed/done with steps + report
# + duration, an @mention employee-helper linked to that employee's live
# session, `LILOS_BG` job streaming into `jobs.list` until `jobs.stop`
# lands job.exited stopped, `session.events` replay rebuilding helpers +
# the job with no duplicates, and a LILOS_HIDE_CAPS relaunch dropping both
# capabilities from a fresh welcome — every call on the phone's own routes
# (session.events, jobs.list, jobs.stop, messages.list, conversations.open).
#
# hermes leg: capability declarations plus whichever subagent/job rows the
# engine produces for the same prompts — delegation and backgrounded
# processes come from its own runtime, so job rows are asserted loosely
# (list + stop exercised when a running job exists).
#   HERMES_PROVIDER + HERMES_MODEL set -> live mode (your signed-in engine).
#   Unset -> stub mode: the deterministic OpenAI stub scripts ONE real
#   `terminal` tool call (labeled stub — never a live-model result).
#
# Prints PASS/FAIL. Exit 0 only on PASS.
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

STUB_PORT=8381
ENGINE="${LILOS_ENGINE:-fake}"
LABEL="engine-fake"
if [ "$ENGINE" = "hermes" ]; then
  if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
    LABEL="hermes live (${HERMES_PROVIDER}/${HERMES_MODEL})"
  else
    LABEL="hermes stub (openai-compatible stub @127.0.0.1:${STUB_PORT}, scripted terminal call)"
    export HERMES_PROVIDER=lilos-stub
    export HERMES_MODEL=stub-1
  fi
fi

STUB_PID=""
CONFIG_BACKUP=""
CONFIG_CREATED=""
HERMES_CONFIG=~/.hermes/config.yaml
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  if [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$HERMES_CONFIG"
  elif [ -n "$CONFIG_CREATED" ]; then
    rm -f "$HERMES_CONFIG"
  fi
  pkill -f "live-181-subagents.ts" 2>/dev/null
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
trap cleanup EXIT

# ── stub mode (hermes leg without credentials) ────────────────────────────
if [ "$LABEL" != "${LABEL#hermes stub}" ]; then
  command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ] || {
    echo "LIVE_ENGINE_UNAVAILABLE: no hermes binary at ~/.local/bin/hermes or on PATH"
    exit 2
  }
  pkill -f "openai-stub.ts ${STUB_PORT}" 2>/dev/null; sleep 0.3
  STUB_TOOL_CALL='{"name":"terminal","arguments":"{\"command\":\"sleep 1 && echo stub-bg-done\",\"background\":true}"}' \
    STUB_REQUEST_LOG=/tmp/openai-stub-181-requests.log \
    bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-181.log 2>&1 &
  STUB_PID=$!
  ok=""
  for _ in $(seq 1 25); do
    curl -fsS -o /dev/null "http://127.0.0.1:${STUB_PORT}/v1/models" 2>/dev/null && ok=1 && break
    sleep 0.2
  done
  [ -n "$ok" ] || { echo "LIVE_ENGINE_UNAVAILABLE: openai stub did not listen on :${STUB_PORT}"; cat /tmp/openai-stub-181.log; exit 2; }
  mkdir -p "$HOME/.hermes"
  if [ -f "$HERMES_CONFIG" ]; then
    CONFIG_BACKUP="/tmp/hermes-config-backup181.$$"
    cp "$HERMES_CONFIG" "$CONFIG_BACKUP"
  else
    CONFIG_CREATED=1
    touch "$HERMES_CONFIG"
  fi
  if ! grep -q "lilos-stub:" "$HERMES_CONFIG"; then
    cat >> "$HERMES_CONFIG" <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
    discover_models: false
    models:
      - stub-1
      - stub-2
EOF
  fi
fi

echo "== issue-181 live leg: subagents & background jobs in a thread (engine=${LABEL}) =="

if bun apps/harness/scripts/live-181-subagents.ts; then
  echo "RESULT: PASS (engine=${LABEL})"
  exit 0
fi
echo "RESULT: FAIL (engine=${LABEL})"
exit 1
