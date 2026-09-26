#!/bin/bash
# Evidence collector for issue #21 — prints registration + runtime state of the
# two launch agents. Safe to run any time.
set -uo pipefail

UID_NUM="$(id -u)"
echo "===== launchctl print gui/$UID_NUM ====="
for label in com.nuncio.lilos.spike.relay com.nuncio.lilos.spike.harness; do
  echo "--- $label"
  launchctl print "gui/$UID_NUM/$label" 2>&1 | grep -E "state|program|pid|last exit|bundle id" | head -12
done

echo "===== heartbeat logs (~/Library/Logs/LilOSSpike) ====="
for f in ~/Library/Logs/LilOSSpike/*.log; do
  [ -f "$f" ] || continue
  echo "--- $f"
  tail -4 "$f"
done

echo "===== BTM disposition (sfltool, 15s cap) ====="
perl -e 'alarm 15; exec @ARGV' sfltool dumpbtm 2>/dev/null | grep -A6 -iE "lilos|nuncio" | head -40 || echo "(dumpbtm timed out or no LilOS items)"

echo "===== uptime / boot ====="
sysctl kern.boottime
uptime
