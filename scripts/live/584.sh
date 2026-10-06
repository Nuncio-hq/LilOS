#!/usr/bin/env bash
# Issue #584 live leg: the Workbench "Suggest commit message" path asks the
# engine via `session.ask` — a side request answered by a HIDDEN throwaway
# session, so the real session's transcript, context and event stream gain
# nothing, and the ask works while the session's own turn is still running.
#
#   bash scripts/live/584.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". STUB_SCRIPT makes the main turn's model call slow (~3.5s) so the
# ask provably overlaps it, then answers the ask with a conventional-commit
# subject. To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/584.sh
#
# HOME is isolated for the run (scratch dir): hermes config/state and every
# LilOS write land there, never the real ~/.hermes or ~/.lilos. The provider
# entry is written into the scratch config — HERMES_BASE_URL defaults to the
# local HPC endpoint when unset.
#
# What it does:
#   1. registers the provider in the SCRATCH hermes config
#   2. runs scripts/live/584.ts: stub provider via lib startStub, then
#      LilOS's engine backend via startHermesServe (--isolated), gateway +
#      engine, agents.list/agents.create, session.start. Asserts:
#        - describe advertises the side_prompt capability
#        - a slow prompt turn starts; mid-turn `session.ask` resolves with
#          a commit-subject answer (AC-2)
#        - neither the ask text nor its answer appears in the session's
#          emitted events or the events.since replay (AC-1)
#        - the in-flight turn still completes end_turn
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

STUB_PORT=8432
SCRATCH=$(mktemp -d /tmp/lilos584-home.XXXXXX)

# Hermes re-mints its install-local launcher (<install>/.hermes/bin/hermes)
# at the HERMES_HOME each invocation ran under — left alone, a scratch-home
# run would leave the REAL `hermes` pointing at a python under the deleted
# scratch dir, breaking every engine on the machine. Snapshot the launcher
# dir and restore it on exit, whatever happens. cp -R, not cp -a: -a keeps
# macOS file flags, and launchers locked `chflags uchg` would make the
# snapshot un-rm-able inside SCRATCH.
INSTALL_BIN="$REAL_HOME/.hermes/hermes-agent/.hermes/bin"
LAUNCHER_SNAPSHOT="$SCRATCH/launcher-backup"
mkdir -p "$LAUNCHER_SNAPSHOT"
if [ -d "$INSTALL_BIN" ]; then
  cp -R "$INSTALL_BIN/." "$LAUNCHER_SNAPSHOT/" 2>/dev/null || true
fi
cleanup() {
  if [ -d "$INSTALL_BIN" ] && [ -n "$(ls -A "$LAUNCHER_SNAPSHOT" 2>/dev/null)" ]; then
    cp -Rf "$LAUNCHER_SNAPSHOT/." "$INSTALL_BIN/" 2>/dev/null || true
  fi
  chflags -R nouchg "$SCRATCH" 2>/dev/null || true
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

# Head-FIFO script: only the main turn's call is scripted — deliberately
# slow (~3.5s) so the ask provably overlaps it (AC-2). The stub pops its
# head only AFTER the delay, so the ask's mid-turn call sees the same head,
# doesn't match, and falls back to STUB_REPLY — which IS the commit subject
# this leg asserts on. Anything else (titles, the turn's tool round-trips)
# gets the same fallback.
export STUB_SCRIPT='[
 {"match":"hello","delayMs":3500,"reply":"Hello back — the main turn finished (slow stub)."}
]'
export STUB_REPLY="feat(workbench): update App.tsx and commit-bar"

if [ "$LABEL" = "stub" ]; then
  # 584.ts spawns the stub itself via scripts/live/lib helpers (startStub
  # waits for the real "listening" line) — here we only hand it the port
  # the provider config above points at, plus the request log path.
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG="$SCRATCH/openai-stub-requests.log"
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-584 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/584.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
