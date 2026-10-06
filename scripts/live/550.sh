#!/usr/bin/env bash
# Issue #550 live leg: a steer the real engine already LANDED must stay out
# of the not-sent tray when the turn is Stopped — engine-hermes emits
# `turn.steered` inside `session.steer`, so on a real engine the landing
# always outruns the ack (the window engine-fake's opposite order hid).
# The "Stopped." note must also never render as a user-style bubble.
#
#   bash scripts/live/550.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a
# deterministic OpenAI-compatible stub (scripts/live/openai-stub.ts) and
# the run is labeled "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/550.sh
#
# Same corrected pattern as scripts/live/482.sh:
#   * HOME is FULLY isolated in a scratch mktemp — hermes config/state and
#     every LilOS write land there, NEVER the real ~/.hermes or ~/.lilos.
#   * The script NEVER pkills or otherwise kills other hermes/serve/engine
#     processes — on Oscar's Mac those are REAL running engines. The stack
#     children die with this run's own process group, nothing else.
#
# What it does:
#   1. writes the provider entry into the SCRATCH hermes config
#   2. runs scripts/live/550.ts: starts the openai-stub when stub mode,
#      boots the real dev slice (relay + harness + vite) with
#      LILOS_ENGINE=hermes, sends a held prompt, sends the steer mid-turn,
#      waits for `turn.steered` on the engine feed (the landing), then
#      Stop — asserts the steered message is still delivered (not dropped
#      into the tray) and the stop note posts `authorKind:"system"`;
#      when Playwright Chromium can launch, opens the DM and screenshots
#      the landed chip + the empty tray + the muted stop note
#   3. PASS/FAIL summary on stdout; screenshots in test-results/live-550/
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

SCRATCH=$(mktemp -d /tmp/lilos550-home.XXXXXX)
STUB_PORT=8431

# ── isolated HOME: everything the run writes lives under the scratch dir ──
export HOME="$SCRATCH/home"
export HERMES_HOME="$SCRATCH/hermes-home"
export LILOS_HOME="$SCRATCH/lilos-home"
mkdir -p "$HOME/.hermes" "$HERMES_HOME" "$LILOS_HOME"

# The isolated HOME hides Playwright's browser cache — point it back at
# the real one so the UI leg can launch Chromium on this machine.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$REAL_HOME/Library/Caches/ms-playwright}"

# Isolated HERMES_HOME makes hermes bootstrap re-provision its tools into
# the scratch dir AND re-mint the real install-local launchers
# (~/.hermes/hermes-agent/.hermes/bin/*) to exec that scratch python —
# which dies with this dir. Snapshot the launcher dir now; restore it on
# exit, whatever happens. cp -R, not cp -p/-a: flag-preserving copies keep
# macOS file flags, and launchers locked `chflags uchg` (Hermes locks them
# during live legs) would make the snapshot un-rm-able inside SCRATCH.
# Same corrected pattern as scripts/live/548.sh.
INSTALL_BIN="$REAL_HOME/.hermes/hermes-agent/.hermes/bin"
LAUNCHER_SNAPSHOT="$SCRATCH/launcher-backup"
mkdir -p "$LAUNCHER_SNAPSHOT"
if [ -d "$INSTALL_BIN" ]; then
  cp -R "$INSTALL_BIN/." "$LAUNCHER_SNAPSHOT/" 2>/dev/null || true
fi

# Kill only what THIS script owns: the children spawned inside 550.ts die
# with it (helpers' exit hook + the detached group kill), and the harness's
# own shutdown closes its `hermes serve` child through the normal path.
# No pkill anywhere — other people's engines stay untouched.
cleanup() {
  if [ -d "$INSTALL_BIN" ] && [ -n "$(ls -A "$LAUNCHER_SNAPSHOT" 2>/dev/null)" ]; then
    for f in "$LAUNCHER_SNAPSHOT/"*; do
      [ -f "$f" ] || continue
      dst="$INSTALL_BIN/$(basename "$f")"
      # A uchg-locked launcher can't be overwritten — and an identical one
      # needs no restore, so skip it before ever touching the flag.
      cmp -s "$f" "$dst" 2>/dev/null && continue
      chflags nouchg "$dst" 2>/dev/null || true
      cp -f "$f" "$dst" 2>/dev/null || true
    done
  fi
  chflags -R nouchg "$SCRATCH" 2>/dev/null || true
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
  # The held turn: the stub delays its answer 90 s so the prompt is really
  # running when the steer lands and Stop is pressed — the same window a
  # real model's thinking time opens. The interrupt ends the turn early;
  # the delay never actually elapses. The first entry answers the warmup
  # turn instantly — it exists to finish the one-time hermes agent build
  # (steers are rejected while agent=None; see 550.ts WARM comment).
  export STUB_SCRIPT="${STUB_SCRIPT:-$(cat <<'EOF'
[
 {"match":"say hi","delayMs":0,"reply":"Hi Oscar!"},
 {"match":"essay about the sea","delayMs":90000,"reply":"held reply"}
]
EOF
)}"
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG=/tmp/openai-stub-550-requests.log
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

echo "== issue-550 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/550.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
