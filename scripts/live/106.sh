#!/usr/bin/env bash
# Issue #106 live leg: approval modes per conversation on a real engine.
#
#   bash scripts/live/106.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/106.sh
#
# What it does:
#   1. registers the stub provider when no real provider is configured
#   2. runs scripts/live/106.ts: real relay + real harness + real `hermes
#      serve`; approvals.setPolicy through the relay passthrough, then one
#      DM conversation that drives `chmod 777 README.md` under Ask (card
#      opens, Once completes the turn) and under Full access (no card, turn
#      completes) — never a fake seam
#   3. PASS/FAIL summary on stdout
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

STUB_PORT=8424
STUB_LOG=$(mktemp -t lilos106-stub-log)
CONFIG_TOUCHED=""
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
cleanup() {
  [ -n "$CONFIG_TOUCHED" ] && cp "$CONFIG_TOUCHED" ~/.hermes/config.yaml
  kill_stale_engine
}
trap cleanup EXIT

if pgrep -f "serve --host 127.0.0.1 --port" >/dev/null 2>&1; then
  echo "note: a 'hermes serve' backend is already running; hermes refuses a second one — stopping it."
  kill_stale_engine
  sleep 1
fi

if [ "$LABEL" = "stub" ]; then
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-106.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-106.$$
  # Reuse a lilos-stub entry a sibling live script already registered.
  EXISTING_PORT=$(grep -A2 'lilos-stub:' ~/.hermes/config.yaml | sed -n 's/.*127\.0\.0\.1:\([0-9]*\).*/\1/p' | head -1)
  [ -n "$EXISTING_PORT" ] && STUB_PORT=$EXISTING_PORT
  if ! grep -q "lilos-stub:" ~/.hermes/config.yaml; then
    cat >> ~/.hermes/config.yaml <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
EOF
  fi
  # The `chmod 777` tool_call each leg needs (Ask + Full) — hermes flags it
  # dangerous, so the approval gate fires for real under manual mode.
  export STUB_SCRIPT='[{"match":"LILOS_FIRST","name":"terminal","arguments":"{\"command\":\"chmod 777 README.md\"}","times":1},{"match":"LILOS_SECOND","name":"terminal","arguments":"{\"command\":\"chmod 777 README.md\"}","times":1}]'
  export STUB_REQUEST_LOG="$STUB_LOG"
  # 106.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — hand it the port the provider
  # config above points at.
  export LILOS_STUB_PORT="$STUB_PORT"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

# #642: connect the `lilos` plugin on the scratch HERMES_HOME exactly like
# connect.ts — sessions must offer lilos_* tools, not log "still not
# loaded". `default` plus `ada` (the leg's "Ada" employee's profile).
. scripts/live/lib/lilos-plugin.sh
lilos_connect_plugin
lilos_clone_profile ada

echo "== issue-106 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/106.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
