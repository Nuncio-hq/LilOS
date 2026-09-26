#!/usr/bin/env bash
# Issue #29 live leg: employee hire/edit/remove through the real relay +
# harness against a REAL `hermes serve`.
#
# What it does (all over the real app protocol — the same calls the UI makes):
#   AC-1 leg — agents.list returns the engine's real profiles
#   AC-2 leg — agents.create creates a real Hermes profile (profile stays on
#              the machine afterwards — profiles are never deleted by design)
#              and employees.create links an employee to it
#   AC-3 leg — employees.update edits the employee's name + role
#   AC-4 leg — employees.remove deletes only the LilOS record; agents.list
#              afterwards still contains the profile
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". Profiles.* are file operations on `~/.hermes`, so they run for real
# either way. To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/issue-29.sh
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
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$CONFIG_TOUCHED" ] && cp "$CONFIG_TOUCHED" ~/.hermes/config.yaml
}
trap cleanup EXIT

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  # Register the stub as a named provider; restore the config on exit.
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

echo "== issue-29 live leg: engine=hermes label=${LABEL} =="
if bun apps/harness/scripts/employees-demo.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
