#!/bin/sh
# Remote-style push into the simulator: same category and ids as the local
# notifications from notify.ts, so the real app can reuse `lilos-ask` later.
# Usage: push.sh <udid> ask-a1|ask-a2|update
UDID=${1:?udid}
exec xcrun simctl push "$UDID" com.nuncio.lilos.mobile "$(dirname "$0")/${2:?payload}.apns"
