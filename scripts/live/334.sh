#!/usr/bin/env bash
# Issue #334 live leg: capture the REAL `hermes serve` wire frames for a
# turn whose reasoning.available summary carries the assistant's answer —
# the "final message duplicated inside the reasoning" Oscar sees on mobile.
#
#   bash scripts/live/334.sh
#
# Same setup as scripts/live/327.sh: with no signed-in LLM, hermes points
# at the deterministic OpenAI stub (scripts/live/openai-stub.ts) and the
# run is labeled "stub". STUB_SCRIPT scripts two legs:
#   1. a plain "391" answer — no chain-of-thought, the reported case:
#      reasoning.available {"text":"391"} lands after the text delta;
#   2. a `reasoning_content` thought then the answer — the general case:
#      a real reasoning stream, then the summary frame that must not
#      append the answer a second time.
#
# To rerun against a real model:
#   HERMES_PROVIDER=<provider> HERMES_MODEL=<model> bash scripts/live/334.sh
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

STUB_PORT=8419
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
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

export STUB_SCRIPT='[
 {"match":"answer plainly","reply":"\n\n391"},
 {"match":"step by step","thought":"17x23: 17*20 is 340, plus 17*3 = 51, so 340+51 = 391.","reply":"\n\n391"}
]'

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-334.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-334.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-334.$$
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

export LILOS_REPO_ROOT="$PWD"

echo "== issue-334 live leg: label=${LABEL} =="
if bun scripts/live/334.ts; then
  echo "RESULT: PASS (label=${LABEL})"
else
  echo "RESULT: FAIL (label=${LABEL})"
  exit 1
fi
