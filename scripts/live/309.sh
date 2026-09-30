#!/usr/bin/env bash
# Issues #309 + #308 live leg: capture the REAL engine→harness frame
# sequence around an async delegate_task.
#
#   bash scripts/live/309.sh
#
# Same setup as scripts/live/288.sh: with no signed-in LLM, hermes points at
# the deterministic OpenAI stub (scripts/live/openai-stub.ts) and the run is
# labeled "stub". STUB_SCRIPT scripts three legs:
#   1. the parent's first model call returns a delegate_task tool call
#   2. the child's model call answers after an 18s delay, so the subagent
#      provably outlives the parent's turn.completed
#   3. the result-delivery leg (its message carries the child's "ZEBRA"
#      summary) delays 12s, so a newer user message's frames are captured
#      interleaved with it
#
# To rerun against a real model:
#   HERMES_PROVIDER=<provider> HERMES_MODEL=<model> bash scripts/live/309.sh
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

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

STUB_PORT=8417
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$CONFIG_TOUCHED" ] && cp "$CONFIG_TOUCHED" ~/.hermes/config.yaml
  kill_stale_engine
}
trap cleanup EXIT

if pgrep -f "serve --host 127.0.0.1 --port" >/dev/null 2>&1; then
  echo "note: a 'hermes serve' backend is already running; hermes refuses a second one — stopping it."
  kill_stale_engine
  sleep 1
fi

export STUB_REQUEST_LOG=/tmp/openai-stub-309-requests.log
export STUB_SCRIPT='[
 {"match":"please delegate now","name":"delegate_task","arguments":"{\"tasks\":[{\"goal\":\"APPLESAUCE task: do a small thing then reply with one sentence containing ZEBRA.\",\"context\":\"You are a background subagent\"}]}"},
 {"match":"applesauce","delayMs":18000,"reply":"Child done — ZEBRA report."},
 {"match":"zebra","delayMs":12000,"reply":"Acknowledged the childs ZEBRA report."}
]'

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-309.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-309.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-309.$$
  if ! grep -q "lilos-stub:" ~/.hermes/config.yaml; then
    cat >> ~/.hermes/config.yaml <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
EOF
  fi
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-309/308 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/309.ts --engine hermes --seconds 75; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
