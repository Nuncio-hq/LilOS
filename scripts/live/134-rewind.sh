#!/usr/bin/env bash
# Issue #134 live leg: rewind a session to before a turn — files AND the
# agent's memory — against real `hermes serve` (real WS protocol).
#
#   bash scripts/live/134-rewind.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". The stub logs every request's message texts to STUB_REQUEST_LOG,
# so the script can prove the rewound turns are gone from the agent's next
# prompt. To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/134-rewind.sh
#
# What it does:
#   1. registers the stub provider when no real provider is configured
#   2. runs scripts/live/134-rewind.ts: real relay + real harness + real
#      `hermes serve`, then a DM conversation in a scratch git folder runs 3
#      turns; marker files simulate the agent's per-turn edits (a real model
#      edits files itself — either way the harness checkpoint owns restore)
#   3. rewind to before turn 2 → asserts files restored (markers 2/3 gone,
#      1 + seed intact, `git status` byte-identical), the message tail is
#      marked rewound, engineRewound=true (WS `session.undo`, looped),
#      and — stub runs — the next prompt's context lacks the dropped turns
#   4. PASS/FAIL summary on stdout
set -u
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

LABEL=stub
command -v hermes >/dev/null 2>&1 || {
  echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
  exit 2
}
if [ "${HERMES_PROVIDER:-}" = "auto" ]; then
  # Use the machine's configured model.provider/model.default verbatim —
  # no override passed to session.create. On this VM that resolves to
  # OpenRouter (model.base_url + OPENROUTER_API_KEY).
  unset HERMES_PROVIDER HERMES_MODEL
  LABEL="live (configured default)"
elif [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  LABEL="live (${HERMES_PROVIDER}/${HERMES_MODEL})"
else
  export HERMES_PROVIDER=lilos-stub
  export HERMES_MODEL=stub-model
fi

STUB_PORT=8413
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  true
}
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$CONFIG_TOUCHED" ] && cp "$CONFIG_TOUCHED" ~/.hermes/config.yaml
  kill_stale_engine
}
trap cleanup EXIT

if pgrep -f "serve --host 127.0.0.1 --port" >/dev/null 2>&1; then
  echo "note: a 'hermes serve' backend is already running; hermes refuses a second one — stopping it."
  kill_stale_engine
  sleep 1
fi

cp ~/.hermes/config.yaml /tmp/hermes-config-backup-134.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-134.$$
if [ "$LABEL" = "stub" ]; then
  export STUB_REQUEST_LOG=/tmp/lilos-134-stub-requests.jsonl
  : > "$STUB_REQUEST_LOG"
  STUB_REPLY="Noted (stub)." bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-134.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
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
export LILOS_REPO_ROOT="$PWD"

echo "== issue-134 live leg: engine=hermes label=${LABEL} =="
if bun scripts/live/134-rewind.ts --engine hermes; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
