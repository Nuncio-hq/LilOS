#!/bin/bash
# Evidence collector for issue #34 — registration + runtime state of the LilOS
# launch agents, relay liveness, and power assertions. Safe to run any time.
set -uo pipefail

UID_NUM="$(id -u)"
echo "===== launchctl print gui/$UID_NUM ====="
for label in com.nuncio.lilos.relay com.nuncio.lilos.harness; do
  echo "--- $label"
  launchctl print "gui/$UID_NUM/$label" 2>&1 | grep -E "state|program|pid|last exit|bundle id" | head -12
done

echo "===== relay /healthz ====="
curl -s --max-time 3 http://127.0.0.1:4577/healthz || echo "(relay not reachable)"
echo

echo "===== service logs (/tmp/com.nuncio.lilos.*) ====="
for f in /tmp/com.nuncio.lilos.*.log; do
  [ -f "$f" ] || continue
  echo "--- $f"
  tail -4 "$f"
done

echo "===== sleep assertions (pmset -g assertions) ====="
pmset -g assertions | grep -iE "PreventUserIdleSystemSleep|caffeinate|harness" || echo "(none held)"

echo "===== BTM disposition (sfltool, 15s cap) ====="
perl -e 'alarm 15; exec @ARGV' sfltool dumpbtm 2>/dev/null | grep -A6 -iE "lilos|nuncio" | head -40 || echo "(dumpbtm timed out or no LilOS items)"

echo "===== uptime / boot ====="
sysctl kern.boottime
uptime
