#!/usr/bin/env bash
# Issue #32 live leg: notifications + badges against a REAL `hermes serve`,
# same spec as CI (e2e/ac-32-notifications.spec.ts) with LILOS_ENGINE=hermes.
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/32.sh
#
# The live leg asserts the deterministic half of the slice: a real engine
# turn finishing out of view posts a notification, and the click opens that
# exact conversation. Approval/failure legs are engine-fake-only — a real
# model can't be forced into either deterministically — and the notification
# code path is engine-protocol events only (nothing Hermes-specific).
set -u
cd "$(dirname "$0")/../.."
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

# The auto-hired `default` agent profile carries the config's model.default
# as its pinned model, and that pin wins over the serve --model fallback —
# point it at the provider under test for the duration of this script.
MODEL_DEFAULT="${HERMES_PROVIDER}/${HERMES_MODEL}"

STUB_PORT=8399
STUB_PID=""
CONFIG_TOUCHED=""
kill_stale_engine() {
  pkill -f "apps/harness/src/index.ts" 2>/dev/null
  pkill -f "apps/relay/src/index.ts" 2>/dev/null
  pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
  pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  pkill -f "dev/stack.ts" 2>/dev/null
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

if [ "$LABEL" = "stub" ]; then
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-32.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
fi
cp ~/.hermes/config.yaml /tmp/hermes-config-backup-32.$$ && CONFIG_TOUCHED=/tmp/hermes-config-backup-32.$$
if [ "$LABEL" = "stub" ] && ! grep -q "lilos-stub:" ~/.hermes/config.yaml; then
  cat >> ~/.hermes/config.yaml <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
EOF
fi
python3 - "$MODEL_DEFAULT" <<'EOF'
import re, sys
path = __import__("os").path.expanduser("~/.hermes/config.yaml")
src = open(path).read()
pat = re.compile(r'^(\s*default:\s*).*$', re.M)
m = pat.search(src)
if not m:
    sys.exit("config.yaml: no model.default line found")
open(path, "w").write(pat.sub(r'\g<1>"' + sys.argv[1] + '"', src, count=1))
EOF

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-32 live leg: engine=hermes label=${LABEL} =="
if bunx playwright test e2e/ac-32-notifications.spec.ts --reporter=list; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
