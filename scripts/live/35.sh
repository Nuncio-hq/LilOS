#!/usr/bin/env bash
# Live rerun of issue #35 on this machine — two real ad-hoc builds and a
# local update feed:
#
#   AC-3  v1.0.1 running -> feed advertises 1.0.2 -> app quits, the applier
#         swaps the bundle, the new build re-registers the launch agents and
#         passes the version handshake -> status "updated", system.status
#         reports relay+harness at 1.0.2.
#   AC-4  feed then advertises 1.0.3 whose bundle carries a version-skewed
#         relay (still reports 1.0.2) -> the new build's handshake verify
#         fails -> the applier restores 1.0.2 -> status "rolled-back", the
#         bad build lands on the skip list.
#
#   scripts/live/35.sh
#
# Needs macOS + bun (BUN env to point at it). Self-contained: scratch dir,
# temporary launch agents are left as they were found. Prints PASS/FAIL.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
export PATH="$(dirname "$BUN"):$PATH"
# Stable work/install path across runs: launchd's BTM database keys agent
# registrations by bundle path — a fresh mktemp path each run leaves stale
# registrations pointing at deleted bundles and new spawns fail EX_CONFIG.
WORK="${LILOS_LIVE35_DIR:-$HOME/.cache/lilos-live35}"
# Bootout BEFORE wiping: a leftover keepalive agent pointing at $WORK while
# the bundle is absent spawn-fails into a launchd throttle (EX_CONFIG) and
# poisons the registration the run is about to remake.
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.relay" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.harness" 2>/dev/null || true
rm -rf "$WORK"; mkdir -p "$WORK"
FEED_DIR="$WORK/feed"
INSTALL="$WORK/install"
STATE_DIR="$WORK/state"
FEED_PORT="${LILOS_FEED_TEST_PORT:-4598}"
APP_PATH="$INSTALL/LilOS.app"
BUILD_DIST="$ROOT/apps/desktop/dist"
PASS=(); FAIL=()

ok()  { PASS+=("$1"); echo "PASS  $1"; }
bad() { FAIL+=("$1"); echo "FAIL  $1"; }
step(){ echo; echo "== $*"; }

APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "${FEED_PID:-}" ] && kill "$FEED_PID" 2>/dev/null || true
  pkill -f "$(cd "$INSTALL" 2>/dev/null && pwd -P)/LilOS.app" 2>/dev/null || true
  # Agents stay registered: the path is stable across runs, so next run's
  # ensureServices sees a consistent BTM state instead of a dangling one.
}
trap cleanup EXIT

wait_for() { # file-or-cmd... use: wait_for <seconds> <bash -c snippet>
  local t="$1" cmd="$2" i
  for i in $(seq 1 "$((t * 10))"); do
    eval "$cmd" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

healthz_version() {
  curl -fsS --max-time 2 "http://127.0.0.1:4577/healthz" 2>/dev/null \
    | "$BUN" -e 'process.stdin.on("data",d=>{try{process.stdout.write(JSON.parse(d).relayVersion)}catch{}})' || true
}
bundle_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "?"
}
feed_for() { # <zip> <version> <build>
  scripts/release/make-feed.sh "$1" "$2" "$3" \
    "http://127.0.0.1:$FEED_PORT/$(basename "$1")" > "$FEED_DIR/update-feed.json"
}
pack_zip() { # <appdir> <out.zip>
  rm -f "$2"; (cd "$(dirname "$1")" && ditto -c -k --keepParent "$(basename "$1")" "$2")
}
sys_versions() { # prints "relay=x harness=y" from the live relay
  LILOS_RELAY_URL="ws://127.0.0.1:4577/ws" "$BUN" apps/desktop/scripts/probe-status.ts 2>/dev/null \
    | "$BUN" -e 'process.stdin.on("data",d=>{try{const s=JSON.parse(d);process.stdout.write(`relay=${s.versions.relay} harness=${s.versions.harness??"?"} mismatch=${!!s.mismatch}`)}catch{}})' || true
}

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only"; exit 1; }

# Stray relays/harnesses from earlier runs hold the port/lock and make the
# launch agents exit EX_CONFIG — clean the slate first.
pkill -f 'LilOS.app/Contents/MacOS/lilos-(relay|harness|engine-fake)' 2>/dev/null || true
pkill -f 'LilOS.app/Contents/MacOS/LilOS' 2>/dev/null || true
lsof -ti :4577 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ---------------------------------------------------------------------------
step "build v1.0.1 + v1.0.2 + skewed v1.0.3 (ad-hoc)"
mkdir -p "$WORK/payloads"
"$BUN" apps/desktop/scripts/build.ts 1 - >/dev/null
pack_zip "$BUILD_DIST/LilOS.app" "$FEED_DIR/lilos-1.zip"
ditto "$BUILD_DIST/LilOS.app" "$WORK/v1.app"

"$BUN" apps/desktop/scripts/build.ts 2 - >/dev/null
pack_zip "$BUILD_DIST/LilOS.app" "$FEED_DIR/lilos-2.zip"
ditto "$BUILD_DIST/LilOS.app" "$WORK/v2.app"

"$BUN" apps/desktop/scripts/build.ts 3 - >/dev/null
# Skewed build: the v3 bundle claims 1.0.3 but carries the v2 relay binary —
# the post-update handshake then sees relay=1.0.2 != app=1.0.3 and must
# roll back (covers any half-broken bundle, not just a crash).
ditto "$WORK/v2.app/Contents/MacOS/lilos-relay" \
  "$BUILD_DIST/LilOS.app/Contents/MacOS/lilos-relay"
codesign --force --deep --sign - "$BUILD_DIST/LilOS.app" >/dev/null 2>&1
pack_zip "$BUILD_DIST/LilOS.app" "$FEED_DIR/lilos-3.zip"

step "serve local update feed on 127.0.0.1:$FEED_PORT"
feed_for "$FEED_DIR/lilos-1.zip" "1.0.1" 1
(cd "$FEED_DIR" && exec python3 -m http.server "$FEED_PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
FEED_PID=$!
wait_for 10 "curl -fsS http://127.0.0.1:$FEED_PORT/update-feed.json" \
  && ok "feed up" || { bad "feed server"; exit 1; }

step "install v1.0.1 and launch"
ditto "$WORK/v1.app" "$APP_PATH"
mkdir -p "$STATE_DIR"
env LILOS_UPDATE_URL="http://127.0.0.1:$FEED_PORT/update-feed.json" \
    LILOS_UPDATE_CHECK_MS=2000 \
    LILOS_UPDATE_TRACE=1 \
    LILOS_STATE_DIR="$STATE_DIR" \
    "$APP_PATH/Contents/MacOS/LilOS" >"$WORK/app.log" 2>&1 &
APP_PID=$!

step "AC-3: feed -> v1.0.2, app must update itself"
feed_for "$FEED_DIR/lilos-2.zip" "1.0.2" 2
if wait_for 90 "[ \"\$(cat '$STATE_DIR/update/status.json' 2>/dev/null | grep -o updated)\" = updated ]"; then
  ok "AC-3 swap completed (status.json = updated)"
else
  bad "AC-3 swap timed out"; tail -5 "$WORK/app.log" 2>/dev/null; tail -5 "$STATE_DIR/update/update.log" 2>/dev/null
fi
sleep 2  # let the relaunched v2 finish booting + re-registering agents
APP_PID=""  # app restarted itself; we no longer own the pid

V="$(bundle_version)"
[ "$V" = "1.0.2" ] && ok "AC-3 bundle on disk is $V" || bad "AC-3 bundle version is $V, want 1.0.2"
if wait_for 60 "[ \"\$(healthz_version)\" = 1.0.2 ]"; then
  ok "AC-3 relay agent restarted at 1.0.2 (/healthz)"
else
  bad "AC-3 /healthz reports $(healthz_version), want 1.0.2"
fi
if wait_for 60 "sys_versions | grep -q 'relay=1.0.2 harness=1.0.2 mismatch=false'"; then
  ok "AC-3 version handshake passed after update (relay+harness at 1.0.2)"
else
  bad "AC-3 handshake did not converge: $(sys_versions)"
fi

step "AC-4: feed -> skewed v1.0.3, app must roll back to 1.0.2"
feed_for "$FEED_DIR/lilos-3.zip" "1.0.3" 3
if wait_for 180 "grep -q 'rolled-back' '$STATE_DIR/update/status.json' 2>/dev/null"; then
  ok "AC-4 failed update rolled back (status.json = rolled-back)"
else
  bad "AC-4 no rollback recorded"; tail -10 "$STATE_DIR/update/update.log" 2>/dev/null
fi
sleep 2
V="$(bundle_version)"
[ "$V" = "1.0.2" ] && ok "AC-4 back on working version $V" || bad "AC-4 bundle version is $V, want 1.0.2"
if wait_for 60 "[ \"\$(healthz_version)\" = 1.0.2 ]"; then
  ok "AC-4 relay back at 1.0.2 after rollback"
else
  bad "AC-4 /healthz reports $(healthz_version) after rollback"
fi
if [ -f "$STATE_DIR/update/skipped-builds.json" ] && grep -q '3' "$STATE_DIR/update/skipped-builds.json"; then
  ok "AC-4 bad build 3 skipped permanently"
else
  bad "AC-4 skip list did not record build 3"
fi

echo
echo "==== live/35 summary ===="
printf 'PASS %d  FAIL %d\n' "${#PASS[@]}" "${#FAIL[@]}"
[ "${#FAIL[@]}" = 0 ]
