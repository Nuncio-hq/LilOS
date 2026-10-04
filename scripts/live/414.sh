#!/usr/bin/env bash
# Issue #414 live leg: text the agent writes BEFORE a tool call must show
# once in the turn — real `hermes serve`, real wire, folded the way the
# thread does.
#
#   bash scripts/live/414.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". STUB_SCRIPT scripts one assistant message carrying commentary
# text + a real `tool_call` (todo_list), which is what makes upstream emit
# `message.interim`. To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/414.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to
# the local HPC endpoint when unset.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/414.ts: stub provider via lib startStub, then a
#      real `hermes serve` + gateway + engine — records wire frames and
#      engine frames side by side, auto-answers approval asks, folds the
#      engine log with reduceSessionEvents, then asserts every
#      `message.interim` text occurs EXACTLY ONCE in the folded turn text
#   3. PASS/FAIL summary on stdout (plus a dual wire->engine timeline)
set -u
cd "$(dirname "$0")/../.."
REAL_HOME=$HOME
export PATH="$REAL_HOME/.bun/bin:$REAL_HOME/.local/bin:$PATH"

LABEL=stub
if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  LABEL="live (${HERMES_PROVIDER}/${HERMES_MODEL})"
else
  command -v hermes >/dev/null 2>&1 || {
    echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
    exit 2
  }
  export HERMES_PROVIDER=lilos-stub
  export HERMES_MODEL=stub-model
fi

STUB_PORT=8425
SCRATCH=$(mktemp -d /tmp/lilos414-home.XXXXXX)
kill_stale_engine() {
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
cleanup() {
  kill_stale_engine
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if pgrep -f "serve --host 127.0.0.1 --port" >/dev/null 2>&1; then
  echo "note: a 'hermes serve' backend is already running; hermes refuses a second one — stopping it."
  kill_stale_engine
  sleep 1
fi

# ── isolated HOME: everything the run writes lives under the scratch dir ──
export HOME="$SCRATCH/home"
export HERMES_HOME="$SCRATCH/hermes-home"
export LILOS_HOME="$SCRATCH/lilos-home"
mkdir -p "$HOME/.hermes" "$HERMES_HOME" "$LILOS_HOME"

if [ "$LABEL" = "stub" ]; then
  PROVIDER_BASE_URL="http://127.0.0.1:${STUB_PORT}/v1"
else
  # The local HPC endpoint the orchestrator's live runs use; override with
  # HERMES_BASE_URL for any other provider.
  PROVIDER_BASE_URL="${HERMES_BASE_URL:-http://127.0.0.1:8000/v1}"
fi
for cfg in "$HOME/.hermes/config.yaml" "$HERMES_HOME/config.yaml"; do
  cat > "$cfg" <<EOF
providers:
  ${HERMES_PROVIDER}:
    base_url: "${PROVIDER_BASE_URL}"
    api_mode: ${HERMES_API_MODE:-chat_completions}
    api_key: "${HERMES_API_KEY:-stub}"
EOF
done

# One assistant message = commentary text + a real tool_call (todo_list
# needs no approval) -> the wire's message.interim seal. The follow-up
# model call (tool result in) answers the final line.
export STUB_SCRIPT='[
 {"match":"subtract","reply":"LILOS414 pre-tool sentence: no test framework is set up in this repo, so I will write the test using node:test.","name":"tool_call","arguments":"{\"calls\":[{\"name\":\"todo_list\",\"arguments\":{\"todos\":[{\"id\":\"1\",\"content\":\"Add subtract()\",\"status\":\"in_progress\"},{\"id\":\"2\",\"content\":\"Write the node:test file\",\"status\":\"pending\"}]}}]}"},
 {"match":"subtract","reply":"Done: subtract() and its test are in place."}
]'

if [ "$LABEL" = "stub" ]; then
  # 414.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — here we only hand it the port
  # the provider config above points at, plus the request log path.
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG=/tmp/openai-stub-414-requests.log
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-414 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/414.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
