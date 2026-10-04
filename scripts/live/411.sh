#!/usr/bin/env bash
# Issue #411 live leg: cold start on a real `hermes serve` — the first
# session must offer every lilos_* tool and agent.log must show no plugin
# load timeout.
#
#   bash scripts/live/411.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". STUB_SCRIPT scripts one `lilos_context` tool call so the tool
# round-trip is exercised end to end. To rerun against a real model on
# Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/411.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to
# the local HPC endpoint when unset.
#
# NOTE: unlike older live scripts this one NEVER pkills or kills engine
# processes — on Oscar's Mac those are real running engines. Everything it
# spawns is cleaned up by 411.ts itself.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/411.ts: stub provider via lib startStub, then the
#      real surfaces gateway + a real `hermes serve` + gateway + engine,
#      copies the lilos plugin into the profile and enables it exactly like
#      connect.ts does, starts a session, prompts, then asserts:
#        - the session's wire `tools.list` carries `lilos_context`
#        - agent.log has no "load timed out"/"after its load timed out"
#        - a lilos_* tool call actually ran
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

STUB_PORT=8426
SCRATCH=$(mktemp -d /tmp/lilos411-home.XXXXXX)

# Hermes re-mints its install-local launcher (<install>/.hermes/bin/hermes)
# at the HERMES_HOME each invocation ran under — left alone, a scratch-home
# run would leave the REAL `hermes` pointing at a python under the deleted
# scratch dir, breaking every engine on the machine. Snapshot the launcher
# dir and restore it on exit, whatever happens.
INSTALL_BIN="$REAL_HOME/.hermes/hermes-agent/.hermes/bin"
LAUNCHER_SNAPSHOT="$SCRATCH/launcher-backup"
mkdir -p "$LAUNCHER_SNAPSHOT"
if [ -d "$INSTALL_BIN" ]; then
  cp -a "$INSTALL_BIN/." "$LAUNCHER_SNAPSHOT/" 2>/dev/null || true
fi
cleanup() {
  if [ -d "$INSTALL_BIN" ] && [ -n "$(ls -A "$LAUNCHER_SNAPSHOT" 2>/dev/null)" ]; then
    cp -af "$LAUNCHER_SNAPSHOT/." "$INSTALL_BIN/" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ── isolated HOME: everything the run writes lives under the scratch dir ──
export HOME="$SCRATCH/home"
export HERMES_HOME="$SCRATCH/hermes-home"
export LILOS_HOME="$SCRATCH/lilos-home"
mkdir -p "$HOME/.hermes" "$HERMES_HOME" "$LILOS_HOME"

# Share the machine's provisioned hermes toolchain (python/node/uv under
# ~/.hermes/tools) instead of letting the scratch home re-provision —
# re-provisioning is what triggers the launcher re-mint above. Toolchain,
# not state: the run's config/sessions/logs still stay isolated.
if [ -d "$REAL_HOME/.hermes/tools" ]; then
  ln -s "$REAL_HOME/.hermes/tools" "$HERMES_HOME/tools"
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

# The prompt asks for the LilOS tools; the stub answers the first model call
# with a scripted `lilos_context` tool_call (proves the registered tool
# reaches the model side and round-trips through the real gateway), and the
# follow-up request (tool result in) answers the final line.
export STUB_SCRIPT='[
 {"match":"LilOS","name":"lilos_context","arguments":"{}"},
 {"match":"LilOS","reply":"I am a LilOS employee on the team — answered via lilos_context."}
]'

if [ "$LABEL" = "stub" ]; then
  # 411.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — here we only hand it the port
  # the provider config above points at, plus the request log path.
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG=/tmp/openai-stub-411-requests.log
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-411 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/411.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
