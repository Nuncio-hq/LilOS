#!/usr/bin/env bash
# Live-engine rerun for issue #33 (system status + diagnostics + handshake).
#
# Spawns a real relay, the harness demo driver supervising a real engine,
# then calls system.status on the app protocol and prints each leg plus a
# PASS/FAIL summary.
#
# Defaults use the deterministic engine-fake so the script always runs.
# For a live model (Oscar's Mac):
#
#   LILOS_ENGINE=hermes HERMES_PROVIDER=openrouter \
#     HERMES_MODEL=anthropic/claude-opus-4.6 scripts/live/33.sh
#
# Env knobs (all optional):
#   LILOS_ENGINE    fake (default) | hermes | broken
#   HERMES_PROVIDER / HERMES_MODEL  passed to `hermes serve`
#   LILOS_DEMO_SESSIONS  engine sessions to open (default 1)
#   LILOS_RELAY_PORT  relay listen port (default 4577)

set -euo pipefail
cd "$(dirname "$0")/../.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
PORT="${LILOS_RELAY_PORT:-4577}"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lilos-live33.XXXXXX")"
ENGINE="${LILOS_ENGINE:-fake}"
SESSIONS="${LILOS_DEMO_SESSIONS:-1}"

cleanup() {
  [ -n "${HARN_PID:-}" ] && kill "$HARN_PID" 2>/dev/null || true
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "== relay (port $PORT, home $HOME_DIR)"
LILOS_RELAY_HOME="$HOME_DIR" LILOS_RELAY_PORT="$PORT" \
  "$BUN" apps/relay/src/index.ts >"$HOME_DIR/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 50); do
  grep -q "listening on" "$HOME_DIR/relay.log" 2>/dev/null && break
  sleep 0.2
done
grep -q "listening on" "$HOME_DIR/relay.log" || {
  echo "FAIL: relay did not start"; tail -5 "$HOME_DIR/relay.log"; exit 1;
}
TOKEN="$(tr -d '[:space:]' < "$HOME_DIR/relay-token")"

echo "== harness demo (engine=$ENGINE sessions=$SESSIONS)"
LILOS_RELAY_URL="ws://127.0.0.1:$PORT/ws" LILOS_RELAY_TOKEN="$TOKEN" \
  LILOS_ENGINE="$ENGINE" LILOS_DEMO_SESSIONS="$SESSIONS" \
  LILOS_STATUS_INTERVAL_MS=2000 \
  "$BUN" apps/harness/scripts/demo-status.ts >"$HOME_DIR/harness.log" 2>&1 &
HARN_PID=$!

for _ in $(seq 1 100); do
  grep -q '"state":"running"' "$HOME_DIR/harness.log" 2>/dev/null && break
  grep -q '"state":"failed"' "$HOME_DIR/harness.log" 2>/dev/null && break
  sleep 0.3
done
# Reports ride a 2s cadence — wait one interval so the probe sees the
# post-running report, not the startup one.
sleep 3

echo "== system.status probe"
LILOS_PROBE_URL="ws://127.0.0.1:$PORT/ws" LILOS_PROBE_TOKEN="$TOKEN" \
  "$BUN" -e '
import { RelayClient } from "./packages/client-runtime/src/index.ts";
const c = new RelayClient({
  url: process.env.LILOS_PROBE_URL!,
  token: process.env.LILOS_PROBE_TOKEN!,
  client: { name: "live-33", version: "0.0.0" },
});
await c.connect();
const r = await c.systemStatus({ logLines: 5 });
for (const x of r.components)
  console.log(`  ${x.id.padEnd(8)} ${x.state.padEnd(10)} ${x.reason}`);
console.log(`  engine: ${r.engine?.name ?? "-"} v${r.engine?.version ?? "-"} rss=${r.engine?.rssBytes ?? "-"} sessions=${r.engine?.sessions ?? "-"}`);
console.log(`  mismatch: ${r.mismatch ? `update the ${r.mismatch.update}` : "none"}`);
const allOk = r.components.every((x) => x.state === "ok");
console.log(allOk ? "PASS — all four legs ok" : "FAIL — see legs above");
c.close();
process.exit(allOk ? 0 : 1);
'
