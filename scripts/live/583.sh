#!/usr/bin/env bash
# Issue #583 live leg (Group C: 583/585/589 wire legs): on a real `hermes
# serve`, the system.status call the first-run ticks read comes back ok,
# a gated tool call opens a real approval ask (the thing that parks the
# composer into "waiting for your approval"), and answering Deny leaves a
# RESOLVED ask on the wire (the card the thread keeps showing).
#
#   bash scripts/live/583.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at the
# deterministic OpenAI stub (scripts/live/openai-stub.ts) and the run is
# labeled "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/583.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to
# the local HPC endpoint when unset. Nothing outside the spawned children
# is signalled.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/583.ts: real relay + real harness + real `hermes
#      serve`, then asserts the Group-C wire legs end to end
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

STUB_PORT=8433
STUB_PID=""
SCRATCH=$(mktemp -d /tmp/lilos583-home.XXXXXX)

# With HERMES_HOME moved, each `hermes` launch re-mints the INSTALLED
# launchers (~/.hermes/hermes-agent/.hermes/bin/*) bound to the scratch
# python — deleted by cleanup, leaving `hermes` broken (exit 126).
# Snapshot them first and restore on the way out; the tools symlink below
# also keeps bootstrap from re-provisioning the toolchain into scratch.
SHIM_BACKUP="$SCRATCH/shim-backup"
SHIM_DIR="$REAL_HOME/.hermes/hermes-agent/.hermes/bin"
[ -d "$SHIM_DIR" ] && cp -R "$SHIM_DIR" "$SHIM_BACKUP"

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  if [ -d "$SHIM_BACKUP" ]; then
    rm -rf "$SHIM_DIR"
    cp -R "$SHIM_BACKUP" "$SHIM_DIR"
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ── isolated HOME: everything the run writes lives under the scratch dir ──
export HOME="$SCRATCH/home"
export HERMES_HOME="$SCRATCH/hermes-home"
export LILOS_HOME="$SCRATCH/lilos-home"
mkdir -p "$HOME/.hermes" "$HERMES_HOME" "$LILOS_HOME"

# With HERMES_HOME moved, hermes_bootstrap would provision a fresh python
# toolchain under it — and re-bake the INSTALLED shim's exec line at that
# deleted. Symlinking the real toolchain in satisfies the probe so the
# shim is never touched.
if [ -d "$REAL_HOME/.hermes/tools" ]; then
  ln -sfn "$REAL_HOME/.hermes/tools" "$HERMES_HOME/tools"
fi

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

export STUB_REQUEST_LOG="$SCRATCH/live-583-requests.log"
# The scripted first call runs a real `chmod 777` through the terminal
# tool — hermes flags it dangerous so under manual approvals a real
# permission ask reaches the wire (the open ask that parks the composer).
# After the answer, the follow-up model call answers the final line.
export STUB_SCRIPT='[
 {"match":"LILOS583","name":"terminal","arguments":"{\"command\":\"chmod 777 README.md\"}","times":1},
 {"match":"LILOS583","reply":"Done — the command was handled."}
]'

if [ "$LABEL" = "stub" ]; then
  # 583.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — hand it the port the provider
  # config above points at.
  export LILOS_STUB_PORT="$STUB_PORT"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-583 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/583.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
