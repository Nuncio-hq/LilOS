#!/bin/sh
# Lock a simulator like the side button does. `simctl` has no lock command;
# Simulator's Device → Lock needs a window on an unlocked Mac, while idb sends
# the same HID button headlessly.
# Usage: lock.sh <udid>
UDID=${1:?udid}
if ! pgrep -f "idb_companion --udid $UDID" >/dev/null; then
  nohup idb_companion --udid "$UDID" >"/tmp/idb-companion-$UDID.log" 2>&1 &
  sleep 5
fi
idb connect "$UDID" >/dev/null
idb ui button --udid "$UDID" LOCK
