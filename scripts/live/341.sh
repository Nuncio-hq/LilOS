#!/usr/bin/env bash
# Issue #341 live leg: one real agent call per approval-gated tool on a
# real hermes serve session — plugin -> surfaces gateway -> real harness
# appOps -> real in-process relay -> ask card -> approve/decline.
#
#   bash scripts/live/341.sh
#
# Same isolation contract as 411.sh: HOME/HERMES_HOME/LILOS_HOME point at a
# scratch dir, the lilos-stub provider is deterministic, and nothing it
# spawns is killed outside itself.
#
# The stub scripts one lilos_* tool call per prompt: the first four are
# approved by the run's user client (asks.respond "once") and must apply;
# the last folder_add is declined and must write nothing.
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
SCRATCH=$(mktemp -d /tmp/lilos341-home.XXXXXX)

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
 {"match":"live341 thread","name":"lilos_thread_start","arguments":"{\"title\":\"Vendor notes\",\"text\":\"tracking the vendor thread\"}"},
 {"reply":"started the thread"},
 {"match":"live341 hire","name":"lilos_team_hire","arguments":"{\"name\":\"Bea\",\"role\":\"designer\",\"model\":\"stub-model\",\"instructions\":\"make it pretty\"}"},
 {"reply":"hire proposed"},
 {"match":"live341 update","name":"lilos_team_update","arguments":"{\"role\":\"lead engineer\"}"},
 {"reply":"profile updated"},
 {"match":"live341 folder","name":"lilos_folder_add","arguments":"{\"path\":\"~/work/app\"}"},
 {"reply":"folder added"},
 {"match":"live341 decline-folder","name":"lilos_folder_add","arguments":"{\"path\":\"~/work/nope\"}"},
 {"reply":"declined as expected"}
]'

if [ "$LABEL" = "stub" ]; then
  # 341.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — here we only hand it the port
  # the provider config above points at, plus the request log path.
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG="$SCRATCH/openai-stub-requests.log"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-341 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/341.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
