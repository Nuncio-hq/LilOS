#!/bin/bash
# Spike #22 freeze driver. Freezes the chosen processes (hermes serve tree,
# stub model, probe client) for N seconds — the closest thing this VM can do
# to a real OS sleep, since `pmset sleepnow` fails with 0xe00002e2.
#
# Usage: freeze.sh SECONDS "targets" [transcript]
#   targets: comma list of serve|stub|probe|all (all = everything incl. probe
#            = whole-machine simulation; serve,stub = client stays awake and
#            hits the 45s heartbeat deadline while server is frozen)
# Writes FREEZE_BEGIN/FREEZE_END markers into the transcript.

SECS="$1"; TARGETS="$2"; TRANSCRIPT="${3:-/Users/devin/spike22/transcript.jsonl}"

marker() { python3 "$(dirname "$0")/marker.py" "$1" "$2" "$TRANSCRIPT"; }

tree_pids() {
  # recursive descendants of $1, plus $1 itself
  local root="$1" kids k out="$1"
  kids=$(ps -axo pid=,ppid= | awk -v p="$root" '$2==p{print $1}')
  for k in $kids; do out="$out $(tree_pids "$k")"; done
  echo $out
}

PIDS=""
SERVE_PID=$(lsof -nP -iTCP:9119 -sTCP:LISTEN -t | head -1)
STUB_PID=$(pgrep -f "stub_model.py" | head -1)
PROBE_PID=$(pgrep -f "probe.py" | head -1)

for t in ${TARGETS//,/ }; do
  case "$t" in
    serve) [ -n "$SERVE_PID" ] && PIDS="$PIDS $(tree_pids $SERVE_PID)";;
    stub)  [ -n "$STUB_PID" ]  && PIDS="$PIDS $STUB_PID";;
    probe) [ -n "$PROBE_PID" ] && PIDS="$PIDS $PROBE_PID";;
    all)   [ -n "$SERVE_PID" ] && PIDS="$PIDS $(tree_pids $SERVE_PID)"; [ -n "$STUB_PID" ] && PIDS="$PIDS $STUB_PID"; [ -n "$PROBE_PID" ] && PIDS="$PIDS $PROBE_PID";;
  esac
done
PIDS=$(echo $PIDS | tr ' ' '\n' | sort -un | tr '\n' ' ')
echo "freeze targets=$TARGETS secs=$SECS pids:$PIDS"
marker FREEZE_BEGIN "targets=$TARGETS secs=$SECS pids=$PIDS"
kill -STOP $PIDS 2>/dev/null
marker FROZEN "processes stopped"
sleep "$SECS"
kill -CONT $PIDS 2>/dev/null
marker FREEZE_END "resumed"
echo "resumed after ${SECS}s"
