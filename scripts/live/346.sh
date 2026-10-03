#!/usr/bin/env bash
# Issue #346 live leg: on a real `hermes serve` backend, an idle session
# suspends (life: closed on the wire), its background `sleep` dies, the
# backend's RSS drops, and the next message resumes the SAME session with
# turn 1 in context + the once-only reopened note (AC-2/3/5/6).
#
#   bash scripts/live/346.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at the
# deterministic OpenAI stub (scripts/live/openai-stub.ts) whose STUB_SCRIPT
# fires a real `terminal` tool call (`sleep 371` in the background), and the
# run is labeled "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/346.sh
#
# What it does:
#   1. registers the stub provider when no real provider is configured and
#      scripts the model leg (terminal background call + a memory answer)
#   2. runs scripts/live/346.ts: real relay + real harness + real `hermes
#      serve` at LILOS_SESSION_IDLE_MINUTES=0.25, then asserts suspend/life/
#      process-death/RSS/resume-with-memory end to end
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

STUB_PORT=8419
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

export STUB_REQUEST_LOG=/tmp/live-346-requests.log
: > "$STUB_REQUEST_LOG"
# The scripted first call runs a REAL background `sleep 371` through the
# terminal tool — the process sits under hermes's supervision so a real
# session.close can kill it.
export STUB_SCRIPT='[
 {"match":"codeword","name":"terminal","arguments":"{\"command\":\"sleep 371\",\"background\":true}"},
 {"match":"sleep","reply":"Done — the codeword is ZEBRA_9 and a background sleep 371 is running."},
 {"match":"codeword","reply":"I remember turn 1: the codeword was ZEBRA_9."}
]'

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-346.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-346.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-346.$$
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

echo "== issue-346 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/346.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
