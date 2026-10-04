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
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/346.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to
# the local HPC endpoint when unset. Nothing outside the spawned children
# is signalled: the run's `hermes serve` is 346.ts's own child, so an
# installed LilOS app's engine is left alone.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/346.ts: real relay + real harness + real `hermes
#      serve` at LILOS_SESSION_IDLE_MINUTES=0.25, then asserts suspend/life/
#      process-death/RSS/resume-with-memory end to end
#   3. PASS/FAIL summary on stdout
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

STUB_PORT=8419
STUB_PID=""
SCRATCH=$(mktemp -d /tmp/lilos346-home.XXXXXX)
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

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

export STUB_REQUEST_LOG="$SCRATCH/live-346-requests.log"
# The scripted first call runs a REAL background `sleep 371` through the
# terminal tool — the process sits under hermes's supervision so a real
# session.close can kill it.
export STUB_SCRIPT='[
 {"match":"codeword","name":"terminal","arguments":"{\"command\":\"sleep 371\",\"background\":true}"},
 {"match":"sleep","reply":"Done — the codeword is ZEBRA_9 and a background sleep 371 is running."},
 {"match":"codeword","reply":"I remember turn 1: the codeword was ZEBRA_9."}
]'

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >"$SCRATCH/openai-stub-346.log" 2>&1 &
  STUB_PID=$!
  sleep 0.5
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-346 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/346.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
