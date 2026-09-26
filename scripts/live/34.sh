#!/usr/bin/env bash
# Live rerun of issue #34's acceptance legs against real processes:
#
#   relay (bun) + harness (bun) supervising LILOS_ENGINE, driven through the
#   app protocol by apps/desktop/scripts/drive-turn.ts — the same calls the
#   desktop app makes. Nothing is simulated except the engine default.
#
# Default run uses the deterministic engine-fake:
#
#   scripts/live/34.sh
#
# Real engine on Oscar's Mac (Hermes must have a signed-in provider):
#
#   LILOS_ENGINE=hermes HERMES_PROVIDER=qwen HERMES_MODEL=qwen3.8-flash-next \
#     scripts/live/34.sh
#
# Extra legs when the packaged app is installed at /Applications/LilOS.app:
#   - `launchctl print` shows relay+harness registered as Login-Item agents
#     (AC-1) — the quit/reboot legs themselves are manual (see the PR body).
#
# engine-fake namespaces session ids per process start (#61: s-<run>-<n>), so
# rebinds after the AC-4/AC-5 kills can never collide with the old process's
# ids. Prints one PASS/FAIL line per criterion.
set -euo pipefail
cd "$(dirname "$0")/../.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
PORT="${LILOS_RELAY_PORT:-4579}"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lilos-live34.XXXXXX")"
ENGINE="${LILOS_ENGINE:-fake}"
PASS=(); FAIL=()

cleanup() {
  # Children first: a dead harness orphans its engine + caffeinate, and stray
  # engines poison later pgrep matching.
  [ -n "${HARN_PID:-}" ] && pkill -P "$HARN_PID" 2>/dev/null || true
  [ -n "${HARN_PID:-}" ] && kill "$HARN_PID" 2>/dev/null || true
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT
step() { echo; echo "== $*"; }
ok()   { PASS+=("$1"); echo "PASS  $1"; }
bad()  { FAIL+=("$1"); echo "FAIL  $1"; }
wait_log() { # file pattern timeout_s
  local f="$1" p="$2" t="${3:-30}" i
  for i in $(seq 1 "$((t * 10))"); do
    grep -q "$p" "$f" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
drv() { LILOS_HOME="$HOME_DIR" LILOS_RELAY_URL="ws://127.0.0.1:$PORT/ws" \
  "$BUN" apps/desktop/scripts/drive-turn.ts "$@"; }
# The engine is a direct child of THIS harness (as is its caffeinate helper);
# scope pgrep by parent so a stray engine from an earlier run is never picked.
engine_pid() { pgrep -P "$HARN_PID" -f "serve" | head -1; }
# caffeinate holds "PreventUserIdleSystemSleep" for -w <harness pid>; powerd's
# own assertion of the same name is unrelated, so match the owner process.
# No `cmd | grep -q` under pipefail — grep exiting early SIGPIPEs the producer
# and the pipeline fails even on a match; capture into a var + herestring.
holds_assertion() {
  local out; out="$(pmset -g assertions)"
  grep -q "caffeinate.*PreventUserIdleSystemSleep" <<< "$out"
}
lost_turn() { local m; m="$(drv messages 2>/dev/null)"; grep -q "interrupted" <<< "$m"; }
settled() { local s; s="$(drv state 2>/dev/null)"; ! grep -q '"state":"active"' <<< "$s"; }
wait_for() { # predicate_fn timeout_s -> 0/1
  local t="${2:-30}" i
  for i in $(seq 1 "$((t * 4))"); do
    "$1" && return 0
    sleep 0.25
  done
  return 1
}

step "relay (port $PORT)"
LILOS_RELAY_HOME="$HOME_DIR" LILOS_RELAY_PORT="$PORT" \
  "$BUN" apps/relay/src/index.ts >"$HOME_DIR/relay.log" 2>&1 &
RELAY_PID=$!
wait_log "$HOME_DIR/relay.log" "listening on" 15 || {
  bad "relay start"; tail -5 "$HOME_DIR/relay.log"; exit 1; }
ok "relay start"

step "harness (engine=$ENGINE)"
LILOS_RELAY_URL="ws://127.0.0.1:$PORT/ws" \
  LILOS_RELAY_TOKEN="$(tr -d '[:space:]' < "$HOME_DIR/relay-token")" \
  LILOS_HARNESS_HOME="$HOME_DIR/harness" LILOS_ENGINE="$ENGINE" \
  "$BUN" apps/harness/src/index.ts >"$HOME_DIR/harness.log" 2>&1 &
HARN_PID=$!
wait_log "$HOME_DIR/harness.log" '"state":"running"' 40 || {
  bad "harness start"; tail -10 "$HOME_DIR/harness.log"; exit 1; }
ok "harness start + engine running"

step "AC-4 sleep-sim: freeze harness mid-turn, kill engine, resume"
drv open "Add a footer to the page" >/dev/null
sleep 2                                    # let the turn park on its ask
kill -STOP "$HARN_PID"                     # the "Mac sleeps" simulation
EPID=$(engine_pid || true)
[ -n "$EPID" ] && kill -9 "$EPID"          # engine dies while "asleep"
sleep 20                                   # > the 15s clock-drift threshold
kill -CONT "$HARN_PID"
if wait_log "$HOME_DIR/harness.log" "woke from sleep" 15; then
  ok "AC-4 wake detected + engine socket dropped"
else
  bad "AC-4 wake detected"; tail -8 "$HOME_DIR/harness.log"
fi
wait_for lost_turn 30 \
  && ok "AC-4 lost turn shows interrupted + Retry" \
  || { bad "AC-4 lost turn shows interrupted + Retry"; drv messages | tail -8; }
wait_for settled 30 \
  && ok "AC-4 no spinner (state settles)" \
  || { bad "AC-4 no spinner"; drv state; }

step "turn runs end to end"
drv open "Add a footer to the page" >"$HOME_DIR/open.json"
for _ in $(seq 1 400); do
  drv approve >/dev/null 2>&1 || true
  ST=$(drv state 2>/dev/null || true)
  grep -q '"state":"active"' <<< "$ST" && { sleep 0.25; continue; }
  grep -q '"state":"idle"' <<< "$ST" && break
  sleep 0.25
done
MSGS="$(drv messages)"
grep -q '"employee"' <<< "$MSGS" && ok "turn completes + answer posts" \
  || bad "turn completes + answer posts"

step "AC-3 keep-awake only while a turn runs"
holds_assertion \
  && bad "AC-3 idle Mac stays sleep-able (assertion leaked)" \
  || ok "AC-3 idle: no sleep assertion held"
drv open "Edit every file please" >/dev/null   # parks on approval asks
wait_for holds_assertion 30 \
  && ok "AC-3 mid-turn: idle-sleep assertion held" \
  || bad "AC-3 mid-turn: idle-sleep assertion held"
# A turn can park on several asks back to back — approve until it goes idle.
for _ in $(seq 1 80); do
  drv approve >/dev/null 2>&1 || true
  settled && break
  sleep 0.25
done
if holds_assertion; then
  bad "AC-3 released after turn"
else
  ok "AC-3 released after turn"
fi

step "AC-5 engine crash -> harness restarts it"
EPID=$(engine_pid || true)
[ -n "$EPID" ] && kill -9 "$EPID" || true
# Relaunch takes a beat — wait for a *different* engine child of the harness.
new_engine() { local p; p="$(engine_pid || true)"; [ -n "$p" ] && [ "$p" != "$EPID" ]; }
if wait_for new_engine 20; then
  ok "AC-5 engine restarted"
else
  bad "AC-5 engine restarted"; tail -8 "$HOME_DIR/harness.log"
fi

step "AC-1 launchd registration (only when the app is installed)"
if [ -d /Applications/LilOS.app ]; then
  LP_R="$(launchctl print "gui/$UID/com.nuncio.lilos.relay" 2>/dev/null || true)"
  grep -q "pid = " <<< "$LP_R" && R=1 || R=0
  LP_H="$(launchctl print "gui/$UID/com.nuncio.lilos.harness" 2>/dev/null || true)"
  grep -q "pid = " <<< "$LP_H" && H=1 || H=0
  [ "$R" = 1 ] && [ "$H" = 1 ] \
    && ok "AC-1 relay+harness registered and running under launchd" \
    || bad "AC-1 launchd agents running (relay=$R harness=$H)"
  # A parked turn must not leak its assertion into the AC-3 idle check —
  # nothing here relies on the AC-4 conversation still being current.
else
  echo "SKIP  AC-1 launchd legs (no /Applications/LilOS.app)"
fi

echo
echo "================ ${#FAIL[@]} failures ================"
printf 'PASS: %s\n' "${PASS[@]}"
[ "${#FAIL[@]}" -gt 0 ] && printf 'FAIL: %s\n' "${FAIL[@]}"
[ "${#FAIL[@]}" = 0 ]
