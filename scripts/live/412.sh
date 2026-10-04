#!/usr/bin/env bash
# Issue #412 live leg: an agent shell must see only allow-listed LILOS_*
# env, and a No-folder session must run in the user's home — never inside
# LilOS state ($LILOS_HOME/...).
#
#   bash scripts/live/412.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". STUB_SCRIPT scripts one real `terminal` tool call
# (`env | grep '^LILOS_' | sort; echo LILOS412_PWD=$PWD`) — its output is the
# agent-shell env under test. To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/412.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to
# the local HPC endpoint when unset.
#
# NOTE: like #411's leg, this script NEVER pkills or kills engine processes —
# on Oscar's Mac those are real running engines. Everything it spawns is
# cleaned up by 412.ts itself.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/412.ts: stub provider via lib startStub, then the
#      real relay + real harness (which launches `hermes serve` through the
#      #412 allow-listed env path) → a folder-less DM conversation → the
#      agent's terminal prints `env | grep '^LILOS_'` + pwd; assertions:
#        - the engine process env (ps eww on our own `hermes serve` child)
#          carries no LILOS_RELAY_TOKEN and only allow-listed LILOS_* names
#        - the agent shell's env grep shows the same allow-list only
#        - the agent shell's pwd is $HOME, not under $LILOS_HOME
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

STUB_PORT=8427
SCRATCH=$(mktemp -d /tmp/lilos412-home.XXXXXX)

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

# The harness's launcher resolves `hermes` by discovery — under the isolated
# HOME that misses the real install; point it at the machine's binary.
export HERMES_BIN="$(command -v hermes)"

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

# The first model call answers with a real `terminal` tool call running the
# exact probe an agent would run; the follow-up (tool result in) answers the
# canned reply so the turn settles. `access: "full"` on the conversation
# keeps the call off the approval card — the leg is unsupervised.
export STUB_SCRIPT='[
 {"match":"LILOS412","name":"terminal","arguments":"{\"command\":\"env | grep LILOS_ | sort; echo LILOS412_PWD=$PWD\"}"},
 {"reply":"LILOS412 done."}
]'

if [ "$LABEL" = "stub" ]; then
  # 412.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — here we only hand it the port
  # the provider config above points at, plus the request log path.
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG="$SCRATCH/openai-stub-requests.log"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-412 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/412.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
