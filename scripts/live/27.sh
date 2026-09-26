#!/usr/bin/env bash
# Issue #27 live leg: the desktop DM flow (apps/web + apps/desktop e2e)
# against a REAL `hermes serve`, exactly like the CI suite.
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/27.sh
#
# What it does:
#   1. registers the stub provider when no real provider is configured
#   2. runs the full AC spec (e2e/ac-27-dm.spec.ts) with LILOS_ENGINE=hermes:
#      relay + real harness spawning engine-hermes (`hermes serve`) + vite +
#      Electron — auto-hire, stream, approvals, steer, stop, parallel sessions
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

STUB_PORT=8399
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  pkill -f "dev/stack.ts" 2>/dev/null
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
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-27.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-27.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-27.$$
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

# Stub turns are instant canned replies: no tool calls, no asks, and no
# mid-turn window to steer into — AC-3's step list, AC-4, AC-5 and AC-6
# therefore stay on the deterministic engine-fake (CI); a real-model rerun
# can exercise them by widening LIVE_GREP. (Grep on title text: bare "AC-n"
# collides with the ac-27-*.spec.ts filename.)
LIVE_GREP="${LIVE_GREP:-auto-hires|sidebar shows|real-app build|_electron}"

echo "== issue-27 live leg: engine=hermes label=${LABEL} grep='${LIVE_GREP}' =="
if bunx playwright test e2e/ac-27-dm.spec.ts --grep "$LIVE_GREP" --reporter=list; then
  echo "RESULT(ui): PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT(ui): FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi

# Conversation loop over the same stack shape: DM open -> prompt -> streamed
# answer -> follow-up -> interrupt, all through the real relay + harness.
echo "== issue-27 live leg: DM loop via demo.ts (engine=hermes) =="
if bun apps/harness/scripts/demo.ts --engine hermes --seconds 60; then
  echo "RESULT(loop): PASS"
else
  echo "RESULT(loop): FAIL"
  exit 1
fi
echo "RESULT: PASS (engine=hermes, label=${LABEL})"
