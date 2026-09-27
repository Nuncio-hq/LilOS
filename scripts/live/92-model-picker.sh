#!/usr/bin/env bash
# Issue #92 live leg: model picker v2 — pick {provider?, id} + effort + fast;
# the next turn answers on them; refresh + LilOS-owned hide list round-trip.
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts; models stub-1, stub-2,
# stub/group-1 — the "/" id exercises AC-8 for real) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac (e.g. switch HPC qwen
# <-> a codex model):
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/92-model-picker.sh
#
# What it does:
#   1. starts a real relay + the real harness (apps/harness, LILOS_ENGINE=hermes)
#   2. the harness spawns packages/engine-hermes serve.ts -> `hermes serve`
#   3. a scripted user (apps/harness/scripts/live-92-model-picker.ts) reads
#      the engine catalog + providers off system.status, calls
#      models.list {refresh:true}, settings.set/get (the Edit-models store),
#      sends conversations.setModel with the full pick, then a prompt, and
#      asserts the answer message carries model + effort + fast
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
  export HERMES_MODEL=stub-1
fi

STUB_PORT=8399
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  # Orphans from a previous/aborted run — hermes refuses a second backend.
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/harness/scripts/demo.ts" 2>/dev/null
  pkill -f "apps/harness/scripts/live-92-model-picker.ts" 2>/dev/null
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
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-92.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  # Register the stub as a named provider with three models (one "/" id for
  # AC-8); restore the config on exit.
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup92.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup92.$$
  if ! grep -q "lilos-stub:" ~/.hermes/config.yaml; then
    cat >> ~/.hermes/config.yaml <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
    # declared list is the whole catalog (discover_models off) — the picker
    # needs >=2 entries to switch between and the stub serves any id.
    discover_models: false
    models:
      - stub-1
      - stub-2
      - stub/group-1
EOF
  fi
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$ROOT"

echo "== issue-92 live leg: model picker v2 -> next turn (engine=hermes, label=${LABEL}) =="
if bun apps/harness/scripts/live-92-model-picker.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
