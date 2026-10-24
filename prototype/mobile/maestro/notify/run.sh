#!/bin/sh
# Lock a simulator, push a notification, answer it on the lock screen.
# Usage: run.sh <udid> <payload|local> <approve|deny|open> <shot prefix> <wait regex> [cold|warm]
#   payload  one of ask-a1 / ask-a2 / update (an .apns file in this folder,
#            delivered with `simctl push`); `local` skips the push — the app
#            posts its own notification ~4 s after it backgrounds (lock does it).
#   cold     terminate the app first, so the tap launches it (the
#            getLastNotificationResponseAsync path); warm leaves it suspended.
# Needs JAVA_HOME (openjdk@21) for Maestro. Shots land under /tmp/820b/<run>/.
set -e
UDID=${1:?udid}; PAYLOAD=${2:?payload}; ACTION=${3:?action}; PREFIX=${4:?prefix}; WAIT=${5:?wait regex}; START=${6:-warm}
DIR=$(dirname "$0")
[ "$START" = cold ] && xcrun simctl terminate "$UDID" com.nuncio.lilos.mobile 2>/dev/null || true
# `local`: the app must be up and in front so that locking backgrounds it.
if [ "$PAYLOAD" = local ]; then
  xcrun simctl terminate "$UDID" com.nuncio.lilos.mobile 2>/dev/null || true
  xcrun simctl launch "$UDID" com.nuncio.lilos.mobile >/dev/null
  sleep 20
fi
"$DIR/lock.sh" "$UDID" >/dev/null
sleep 2
if [ "$PAYLOAD" = local ]; then
  # No clearing: the app's own notification lands ~4 s after the lock.
  sleep 8
else
  maestro --device "$UDID" test "$DIR/clear.yaml" >/dev/null
  "$DIR/push.sh" "$UDID" "$PAYLOAD"
  sleep 2
fi
maestro --device "$UDID" test --test-output-dir /tmp/820b -e PREFIX="$PREFIX" -e ACTION="$ACTION" -e WAIT="$WAIT" "$DIR/answer.yaml"
