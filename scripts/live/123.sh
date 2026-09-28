#!/usr/bin/env bash
# Issue #123 live leg: editing an employee's persona (soul) and default model
# through the real relay + harness against a REAL `hermes serve` — the same
# wire calls the shipped app's Edit dialog makes:
#
#   agents.describe (detail.updatable) → agents.create (disposable profile) →
#   agents.update {soul, description} → agents.update {model} (+confirmModel
#   retry when the engine guards the model) → agents.describe reflects →
#   SOUL.md on disk under ~/.hermes/profiles/<slug> → employees.update mirror.
#
# Driven by apps/harness/scripts/persona-demo.ts which boots its own
# relay+harness on free ports, so it can run beside the dev stack.
#
# profiles.configure writes are file operations on `~/.hermes` — they run for
# real whether or not an LLM provider is signed in (no session turn is made).
# When HERMES_PROVIDER + HERMES_MODEL are set the harness pins them on
# `hermes serve` (Oscar's Mac: e.g. the qwen/codex provider); unset, hermes
# is pointed at the deterministic stub and the run is labeled "stub".
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/123.sh
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
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-123.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  # Register the stub as a named provider; restore the config on exit.
  cp ~/.hermes/config.yaml /tmp/hermes-config-backup-123.$$ && \
    CONFIG_TOUCHED=/tmp/hermes-config-backup-123.$$
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

echo "== issue-123 live leg: engine=hermes label=${LABEL} =="
if bun apps/harness/scripts/persona-demo.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
