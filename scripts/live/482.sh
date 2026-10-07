#!/usr/bin/env bash
# Issue #482 live leg: kill the `hermes serve` child under a RUNNING
# adapter and prove the watchdog works for real — calls fail fast typed,
# the backend state is reported, Hermes is relaunched, and the stored
# session resumes with its memory.
#
#   bash scripts/live/482.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a
# deterministic OpenAI-compatible stub (scripts/live/openai-stub.ts) and
# the run is labeled "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/482.sh
#
# CORRECTED PATTERN vs scripts/live/414.sh:
#   * HOME is FULLY isolated in a scratch mktemp — hermes config/state and
#     every LilOS write land there, NEVER the real ~/.hermes or ~/.lilos.
#   * The script NEVER pkills or otherwise kills other hermes/serve/engine
#     processes — on Oscar's Mac those are REAL running engines. The only
#     process it kills is the `hermes serve` child this run spawned itself,
#     found by pid file (the adapter writes HERMES_SERVE_PID_FILE), never
#     by name or port.
#
# What it does:
#   1. writes the provider entry into the SCRATCH hermes config
#   2. runs scripts/live/482.ts: starts the openai-stub when stub mode,
#      launches the REAL adapter (packages/engine-hermes/scripts/serve.ts),
#      runs one turn, holds a second turn in flight, kills ONLY the
#      spawned hermes child by pid, asserts typed fast failures + the
#      reported outage + self-heal + session resume
#   3. PASS/FAIL summary on stdout with the adapter's log lines prefixed
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

SCRATCH=$(mktemp -d /tmp/lilos482-home.XXXXXX)
STUB_PORT=8426

# ── isolated HOME: everything the run writes lives under the scratch dir ──
export HOME="$SCRATCH/home"
export HERMES_HOME="$SCRATCH/hermes-home"
export LILOS_HOME="$SCRATCH/lilos-home"
mkdir -p "$HOME/.hermes" "$HERMES_HOME" "$LILOS_HOME"

# Isolated HERMES_HOME makes hermes bootstrap re-provision its tools into
# the scratch dir AND rewrite the real launcher shims
# (~/.hermes/hermes-agent/.hermes/bin/*) to exec that scratch python —
# which dies with this dir. Snapshot the real shims now; restore them on
# exit so the real install survives the leg.
SHIM_BACKUP="$SCRATCH/shim-backup"
mkdir -p "$SHIM_BACKUP"
for f in "$REAL_HOME/.hermes/hermes-agent/.hermes/bin/"*; do
  [ -f "$f" ] && cp -p "$f" "$SHIM_BACKUP/$(basename "$f")"
done

# Kill only what THIS script owns: the bun children spawned inside 482.ts
# die with it (helpers' exit hook), and our adapter's own SIGTERM closes
# its `hermes serve` child through the normal path. No pkill anywhere —
# other people's engines stay untouched.
cleanup() {
  for f in "$SHIM_BACKUP/"*; do
    [ -f "$f" ] && cp -p "$f" "$REAL_HOME/.hermes/hermes-agent/.hermes/bin/$(basename "$f")"
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [ "$LABEL" = "stub" ]; then
  PROVIDER_BASE_URL="http://127.0.0.1:${STUB_PORT}/v1"
else
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

if [ "$LABEL" = "stub" ]; then
  # The held turn: the stub delays its answer 30 s so the prompt is really
  # in flight when the child dies. The follow-up call (memory check) takes
  # the default canned reply.
  export STUB_SCRIPT="${STUB_SCRIPT:-$(cat <<'EOF'
[
 {"match":"hold the turn","delayMs":30000,"reply":"held reply"}
]
EOF
)}"
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG=/tmp/openai-stub-482-requests.log
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

# #642: connect the `lilos` plugin on the scratch HERMES_HOME exactly like
# connect.ts — sessions must offer lilos_* tools, not log "still not
# loaded". The leg's session.start runs under `default`.
. scripts/live/lib/lilos-plugin.sh
lilos_connect_plugin

echo "== issue-482 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/482.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
