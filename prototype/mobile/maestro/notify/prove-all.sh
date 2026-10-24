#!/bin/sh
# The whole lock-screen matrix for one appearance, screenshots copied to
# /tmp/820b/notify-<appearance>-<leg>-<step>.png.
# Usage: prove-all.sh <udid> <light|dark>
# First: the app in front on Home (before) and a pushed ask arriving while it
# is open (foreground: no banner, the Needs you stack already shows it).
# Legs: approve, deny (ask pushed like a remote push, app killed first so the
# answer arrives through the cold-start path), open-ask and open-update (body
# tap), local (the app's own notification after it goes to the background,
# answered with Approve).
set -u
UDID=${1:?udid}; MODE=${2:?light|dark}
DIR=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/820b
xcrun simctl ui "$UDID" appearance "$MODE"

leg() { # <name> <payload> <action> <wait regex> <cold|warm>
  NAME=$1; PAYLOAD=$2; ACTION=$3; WAIT=$4; START=$5
  "$DIR/run.sh" "$UDID" "$PAYLOAD" "$ACTION" "$MODE-$NAME" "$WAIT" "$START" >/tmp/820b-leg.log 2>&1 \
    || echo "leg $MODE-$NAME FAILED (see /tmp/820b-leg.log)"
  RUN=$(ls -dt "$OUT"/2026-* | head -1)
  for f in "$RUN"/answer/takeScreenshot/*.png; do
    [ -f "$f" ] && cp "$f" "$OUT/notify-$(basename "$f")"
  done
}

shot() { # <name>: simctl writes the file a few seconds after it returns
  xcrun simctl io "$UDID" screenshot "$OUT/notify-$MODE-$1.png" >/dev/null 2>&1
  sleep 6
}
xcrun simctl terminate "$UDID" com.nuncio.lilos.mobile 2>/dev/null
xcrun simctl launch "$UDID" com.nuncio.lilos.mobile >/dev/null
sleep 22
shot before
"$DIR/push.sh" "$UDID" ask-a2
sleep 3
shot foreground-no-banner

leg approve ask-a1 approve "Oscar Co" cold
leg deny ask-a1 deny "Oscar Co" cold
leg open-ask ask-a2 open ".*of [0-9]+.*" cold
leg open-update update open ".*Asked Builder to patch.*" cold
leg local local approve "Oscar Co" warm
