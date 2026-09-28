#!/usr/bin/env bash
# Issue #137 live leg: a new session names itself — placeholder → Hermes'
# instant title → small-model upgrade; a user rename always wins.
#
#   bash scripts/live/137-auto-title.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/137-auto-title.sh
#
# What it does:
#   1. registers the stub provider when no real provider is configured
#   2. runs scripts/live/137.ts: real relay + real harness + real `hermes
#      serve`, then opens one DM conversation with no title — asserting the
#      placeholder, the derived title, the llm upgrade on the conversation
#      row, the session.titled order on the feed, and that a user rename
#      keeps its `user` provenance (AC-1..AC-3)
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

STUB_PORT=8414
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

if [ "$LABEL" = "stub" ]; then
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-137.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-137.$$
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
  pkill -f "openai-stub.ts" 2>/dev/null
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-137.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-137 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/137.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
