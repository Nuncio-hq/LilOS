#!/usr/bin/env bash
# Issue #182 live leg — plans & task lists over the real relay + harness.
#
#   bash scripts/live/182.sh                 # engine-fake: the full flow
#   LILOS_ENGINE=hermes bash scripts/live/182.sh   # hermes leg (cap + tasks)
#
# engine-fake (default): asserts `plan` capability, `plan: tasks` ticking to
# done, `plan: propose` -> asks.respond change -> v2 waiting (v1 replaced)
# -> approve -> steps tick to done, a second conv rejected, and
# `session.events` replay rebuilding both versions — every call on the
# phone's own routes (asks.list/respond, session.events, messages.list).
#
# hermes leg: capability + `kind:"tasks"` streaming only — engine-hermes
# maps todo_list -> plan.updated and has no plan-proposal surface, so the
# decide legs are engine-fake territory by design.
#   HERMES_PROVIDER + HERMES_MODEL set -> live mode (your signed-in engine).
#   Unset -> stub mode: the deterministic OpenAI stub scripts ONE real
#   `todo_list` tool call (labeled stub — never a live-model result).
#
# Prints PASS/FAIL. Exit 0 only on PASS.
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

STUB_PORT=8381
ENGINE="${LILOS_ENGINE:-fake}"
LABEL="engine-fake"
if [ "$ENGINE" = "hermes" ]; then
  if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
    LABEL="hermes live (${HERMES_PROVIDER}/${HERMES_MODEL})"
  else
    LABEL="hermes stub (openai-compatible stub @127.0.0.1:${STUB_PORT}, scripted todo_list call)"
    export HERMES_PROVIDER=lilos-stub
    export HERMES_MODEL=stub-1
  fi
fi

STUB_PID=""
CONFIG_BACKUP=""
CONFIG_CREATED=""
HERMES_CONFIG=~/.hermes/config.yaml
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  if [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$HERMES_CONFIG"
  elif [ -n "$CONFIG_CREATED" ]; then
    rm -f "$HERMES_CONFIG"
  fi
  pkill -f "live-182-plans.ts" 2>/dev/null
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
trap cleanup EXIT

# ── stub mode (hermes leg without credentials) ────────────────────────────
if [ "$LABEL" != "${LABEL#hermes stub}" ]; then
  command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ] || {
    echo "LIVE_ENGINE_UNAVAILABLE: no hermes binary at ~/.local/bin/hermes or on PATH"
    exit 2
  }
  pkill -f "openai-stub.ts ${STUB_PORT}" 2>/dev/null; sleep 0.3
  STUB_TOOL_CALL='{"name":"tool_call","arguments":"{\"calls\":[{\"name\":\"todo_list\",\"arguments\":{\"todos\":[{\"id\":\"1\",\"content\":\"Read the readme\",\"status\":\"in_progress\"},{\"id\":\"2\",\"content\":\"Outline the changes\",\"status\":\"pending\"},{\"id\":\"3\",\"content\":\"Write the plan\",\"status\":\"pending\"}]}}]}"}' \
    STUB_REQUEST_LOG=/tmp/openai-stub-182-requests.log \
    bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-182.log 2>&1 &
  STUB_PID=$!
  ok=""
  for _ in $(seq 1 25); do
    curl -fsS -o /dev/null "http://127.0.0.1:${STUB_PORT}/v1/models" 2>/dev/null && ok=1 && break
    sleep 0.2
  done
  [ -n "$ok" ] || { echo "LIVE_ENGINE_UNAVAILABLE: openai stub did not listen on :${STUB_PORT}"; cat /tmp/openai-stub-182.log; exit 2; }
  mkdir -p "$HOME/.hermes"
  if [ -f "$HERMES_CONFIG" ]; then
    CONFIG_BACKUP="/tmp/hermes-config-backup182.$$"
    cp "$HERMES_CONFIG" "$CONFIG_BACKUP"
  else
    CONFIG_CREATED=1
    touch "$HERMES_CONFIG"
  fi
  if ! grep -q "lilos-stub:" "$HERMES_CONFIG"; then
    cat >> "$HERMES_CONFIG" <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
    discover_models: false
    models:
      - stub-1
      - stub-2
EOF
  fi
fi

echo "== issue-182 live leg: plans & tasks in a thread (engine=${LABEL}) =="

if bun apps/harness/scripts/live-182-plans.ts; then
  echo "RESULT: PASS (engine=${LABEL})"
  exit 0
fi
echo "RESULT: FAIL (engine=${LABEL})"
exit 1
