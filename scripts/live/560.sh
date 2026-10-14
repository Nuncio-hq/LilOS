#!/usr/bin/env bash
# Issue #560 live leg: Compact now on a real engine — the app relay's
# `session.compact` passthrough reaches the hermes adapter, which maps it
# to the gateway's `session.compress`; the typed `session.compacted`
# event lands exactly once with before/after tokens, the thread posts one
# "Context compacted: older turns summarized" system note (replayable,
# deduped on session+seq), and the conversation's persisted meter usage
# drops. The matching e2e/web surface is covered by engine-fake tests —
# this leg proves the REAL adapter end to end.
#
#   bash scripts/live/560.sh
#
# Default (this VM): no signed-in LLM — hermes is pointed at a
# deterministic OpenAI-compatible stub (scripts/live/openai-stub.ts) and
# the run is labeled "stub". To rerun against a real model on Oscar's Mac:
#
#   HERMES_PROVIDER=<named provider slug> \
#   HERMES_MODEL=<model> \
#   [HERMES_BASE_URL=<provider base_url>] [HERMES_API_KEY=<key>] \
#   [HERMES_API_MODE=<api_mode>] \
#   bash scripts/live/560.sh
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
#   2. runs scripts/live/560.ts: starts the openai-stub when stub mode,
#      boots the real dev slice (relay + harness + vite) with
#      LILOS_ENGINE=hermes, runs two content turns so the meter reads
#      nonzero, calls the app relay's `session.compact`, then asserts on
#      the engine feed + the relay rows: one session.compacted event with
#      after<before, one system note, persisted usage down; when
#      Playwright Chromium can launch, opens the DM and screenshots the
#      compaction note + the dropped meter
#   3. PASS/FAIL summary on stdout; screenshots in test-results/live-560/
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

SCRATCH=$(mktemp -d /tmp/lilos560-home.XXXXXX)
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
# Same corrected pattern as scripts/live/548.sh uses.
INSTALL_BIN="$REAL_HOME/.hermes/hermes-agent/.hermes/bin"
LAUNCHER_SNAPSHOT="$SCRATCH/launcher-backup"
mkdir -p "$LAUNCHER_SNAPSHOT"
if [ -d "$INSTALL_BIN" ]; then
  cp -R "$INSTALL_BIN/." "$LAUNCHER_SNAPSHOT/" 2>/dev/null || true
fi

# Kill only what THIS script owns: the children spawned inside 560.ts die
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
  # (steers are rejected while agent=None; see 560.ts WARM comment).
  export STUB_SCRIPT="${STUB_SCRIPT:-$(cat <<'EOF'
[
 {"match":"say hi","delayMs":0,"reply":"Hi Oscar!"},
 {"match":"color of the sky","delayMs":0,"reply":"The sky is blue because of Rayleigh scattering — shorter blue wavelengths scatter far more than red, filling the dome overhead."},
 {"match":"tides","delayMs":0,"reply":"Tides follow the moon's gravity: water bulges toward and away from it, so most coasts see two highs and two lows a day."},
 {"match":"compaction summary","delayMs":0,"reply":"Earlier turns asked about the sky's color and the tides; both were answered plainly."}
]
EOF
)}"
  export LILOS_STUB_PORT="$STUB_PORT"
  export STUB_REQUEST_LOG=/tmp/openai-stub-560-requests.log
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$PWD"

# #642: connect the `lilos` plugin on the scratch HERMES_HOME exactly like
# connect.ts — sessions must offer lilos_* tools, not log "still not
# loaded". `default` plus `builder` (the leg's employee profile).
. scripts/live/lib/lilos-plugin.sh
lilos_connect_plugin
lilos_clone_profile builder

echo "== issue-560 live leg: engine=hermes label=${LABEL} (isolated HOME=${HOME}) =="
if bun scripts/live/560.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
