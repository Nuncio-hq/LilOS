#!/usr/bin/env bash
# Issue #31 live leg: an image attachment rides the real stack end to end —
# real relay + real harness + real `hermes serve` (WS driver, image.attach_bytes).
#
# Default (this VM): no signed-in LLM — hermes is pointed at the deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts), labeled "stub". The stub
# records whether the chat-completions request carried image parts, so the run
# proves the screenshot reached the model boundary — it can't "see" it, a real
# vision model can.
#
# To rerun against a real vision model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<vision-capable model, e.g. a qwen VL> \
#   bash scripts/live/31.sh
#
# Prints a PASS/FAIL summary; on a real-model run the printed answer should
# describe the image (the script sends a 1x1 red PNG — "a red square" is correct).
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
export STUB_REQUEST_LOG="$(mktemp -t lilos-stub-requests)"
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "scripts/live/31.ts" 2>/dev/null
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

echo "== issue-31 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/31.ts --engine hermes --seconds 120; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
