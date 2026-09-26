#!/usr/bin/env bash
# Issue #26 live leg: workspace harness supervising a REAL `hermes serve`.
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/issue-26.sh
#
# What it does:
#   1. starts a real relay + the real harness (apps/harness, LILOS_ENGINE=hermes)
#   2. the harness spawns `bun packages/engine-hermes/scripts/serve.ts`, which
#      spawns `hermes serve` on 127.0.0.1 with a generated token
#   3. a scripted user opens a DM, sends a prompt, answers asks, prints the
#      turn transcript, and exercises turns.interrupt
#   4. PASS/FAIL summary on stdout
set -u
cd "$(dirname "$0")/../.."
ROOT="$PWD"
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

STUB_PORT=8399
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  # Orphans from a previous/aborted run (relay, harness, engine serve.ts and
  # the `hermes serve` python backend — hermes refuses a second backend).
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/harness/scripts/demo.ts" 2>/dev/null
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
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  # Register the stub as a named provider; restore the config on exit.
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup.$$
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
export LILOS_REPO_ROOT="$ROOT"

echo "== issue-26 live leg: engine=hermes label=${LABEL} =="
if bun apps/harness/scripts/demo.ts --engine hermes --seconds 120; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
