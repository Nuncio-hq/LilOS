#!/usr/bin/env bash
# Spike #22 — rerun the real-sleep leg on a physical Mac (Oscar's machine).
#
# The VM used for this spike cannot sleep (`pmset sleepnow` -> error
# 0xe00002e2), so the legs there used SIGSTOP/SIGCONT freezes. On real
# hardware this script performs a TRUE sleep/wake mid-turn against
# `hermes serve` and a real provider.
#
# Usage:
#   HERMES_PROVIDER=openai-codex HERMES_MODEL=<model> ./run_on_real_mac.sh
#   HERMES_PROVIDER=openai-codex HERMES_MODEL=<model> MODE=assertion ./run_on_real_mac.sh
#
#   MODE=sleep     (default) real `sudo pmset sleepnow` mid-turn, then manual wake.
#   MODE=assertion holds `caffeinate -i` for the duration of the turn and dumps
#                  `pmset -g assertions` before/during/after — verifies the
#                  keep-awake contract the harness will use.
#
# Env:
#   HERMES_PROVIDER  provider key as in `hermes model` picker (default: openai-codex)
#   HERMES_MODEL     model id (default: leave config's current default)
#   SLEEP_SECONDS    the `sleep N` the agent runs mid-turn (default: 180;
#                    must comfortably exceed the sleep window)
#   PORT             hermes serve port (default 9119)
#
# Output: transcript.jsonl next to this script + console markers.
# After the run: read the "HOW TO READ THE RESULT" block in README.md.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-9119}"
SLEEP_SECONDS="${SLEEP_SECONDS:-180}"
MODE="${MODE:-sleep}"
TOKEN="spike-token-22"
TRANSCRIPT="$PWD/transcript_real_mac.jsonl"

echo "== preflight =="
hermes --version
pmset -g | grep -E '^ sleep|prevented' || true
if ! sysctl -a 2>/dev/null | grep -q 'kern.osrelease'; then echo "not macOS?"; exit 1; fi

# Real provider via env — this is the whole point of the rerun.
echo "== configure provider: ${HERMES_PROVIDER:-<current>} model: ${HERMES_MODEL:-<current>} =="
[ -n "${HERMES_PROVIDER:-}" ] && hermes config set model.provider "$HERMES_PROVIDER"
[ -n "${HERMES_MODEL:-}" ]    && hermes config set model.default  "$HERMES_MODEL"

# python deps for the probe (websockets)
PYBIN="$PWD/.venv/bin/python3"
if [ ! -x "$PYBIN" ]; then
  python3 -m venv "$PWD/.venv"
  "$PWD/.venv/bin/pip" -q install websockets
fi

echo "== start hermes serve (port $PORT) =="
HERMES_DASHBOARD_SESSION_TOKEN="$TOKEN" nohup hermes serve --port "$PORT" --host 127.0.0.1 \
  > "$PWD/serve_real_mac.log" 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; done

PROMPT="Use the terminal tool to run this exact command now: SLEEP:${SLEEP_SECONDS}"
echo "== start probe turn (sleep $SLEEP_SECONDS) =="
PROBE_TRANSCRIPT="$TRANSCRIPT" "$PYBIN" probe.py --label real-mac-$MODE \
  --prompt "$PROMPT" --duration $((SLEEP_SECONDS * 4)) &
PROBE_PID=$!

echo "waiting for the sleep tool to start..."
for i in $(seq 1 90); do grep -q '"tool.start"' "$TRANSCRIPT" 2>/dev/null && break; sleep 1; done
grep -q '"tool.start"' "$TRANSCRIPT" || { echo "tool.start never arrived — check serve_real_mac.log"; exit 1; }

if [ "$MODE" = "assertion" ]; then
  echo "== MODE=assertion: hold caffeinate -i for the rest of the turn =="
  echo "--- pmset -g assertions BEFORE ---"; pmset -g assertions | tee assertions_before.txt
  caffeinate -i -w $PROBE_PID &   # assertion lives as long as the turn probe
  sleep 1
  echo "--- pmset -g assertions DURING (expect 'caffeinate' in the list) ---"
  pmset -g assertions | tee assertions_during.txt
  pmset -g | grep -E '^ sleep|prevented'
  echo "The Mac may now idle-sleep NATURALLY if you leave it — the assertion should block it."
  echo "Waiting for message.complete (or session.reclaimed)..."
  for i in $(seq 1 $((SLEEP_SECONDS * 4 / 2))); do
    grep -qE '"message.complete"|"session.reclaimed"' "$TRANSCRIPT" && break; sleep 2
  done
  echo "--- pmset -g assertions AFTER turn (caffeinate released once probe exits) ---"
  pmset -g assertions | tee assertions_after.txt
  wait $PROBE_PID || true
else
  echo "== MODE=sleep: the Mac will REALLY sleep in 5s =="
  echo "   wake it by pressing a key after ~30s. The probe reconnects automatically."
  sudo -v                       # prime sudo; pmset sleepnow needs it on some Macs
  sleep 5
  sudo pmset sleepnow || sudo pmset sleepnow   # second try if the first is refused
  echo "== back from sleep (or refused) — watching for turn events =="
  for i in $(seq 1 $((SLEEP_SECONDS * 4 / 2))); do
    grep -qE '"message.complete"|"session.reclaimed"' "$TRANSCRIPT" && break; sleep 2
  done
  wait $PROBE_PID || true
fi

echo
echo "== done. Transcript: $TRANSCRIPT =="
echo "Look for, in order:"
echo "  1. a gap in t_wall between tool.start and the next event (the sleep window)"
echo "  2. probe reconnect: 'heartbeat_dead' -> new gateway.ready -> events.since -> session.activate"
echo "  3. then EITHER tool.complete + message.complete (turn survived)"
echo "     OR session.reclaimed {reason: ws_orphan_reap} ~20s after detach (turn lost)"
echo "     OR status.update provider retries -> message.complete error (provider link died)"
