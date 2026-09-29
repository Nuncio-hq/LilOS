#!/usr/bin/env bash
# Live rerun of issue #206 on this machine — an ad-hoc install, then a
# signed build installed over it, and back:
#
#   AC-1  ad-hoc LilOS.app v901 running (agents registered with
#         `launchctl bootstrap`, plists in ~/Library/LaunchAgents) ->
#         signed v902 opened once -> relay+harness run from the SIGNED
#         bundle (`/healthz` relayVersion = 1.0.902) and the user
#         LaunchAgents plists are gone — no manual launchctl.
#   AC-2  ad-hoc v903 dropped over the signed install -> the bootstrap
#         path still re-registers; `/healthz` = 1.0.903.
#
#   scripts/live/206.sh
#
# Needs macOS + bun + a codesigning identity in the keychain
# (SIGN_IDENTITY env overrides; otherwise the first "iPhone Distribution" /
# "Apple Development" / "Mac Developer" identity is used). A self-signed
# cert (e.g. openssl, EKU codeSigning) imported + trusted in the login
# keychain works too — SMAppService accepts it and exercises the same
# code path as Developer ID; ad-hoc ("-") stays the other backend.
# Self-contained scratch dir; agents are left as found. Prints PASS/FAIL.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
export PATH="$(dirname "$BUN"):$PATH"
# Stable work/install paths across runs: launchd's BTM database keys agent
# registrations by bundle path, so a fresh mktemp path each run poisons the
# next run's registrations (see scripts/live/35.sh).
WORK="${LILOS_LIVE206_DIR:-$HOME/.cache/lilos-live206}"
ADHOC_APP="$WORK/adhoc/LilOS.app"   # stands in for ~/Applications/LilOS.app
SIGNED_APP="$WORK/signed/LilOS.app" # stands in for /Applications/LilOS.app
STATE_DIR="$WORK/state"
BUILD_DIST="$ROOT/apps/desktop/dist"
PASS=(); FAIL=()

ok()  { PASS+=("$1"); echo "PASS  $1"; }
bad() { FAIL+=("$1"); echo "FAIL  $1"; }
step(){ echo; echo "== $*"; }

wait_for() { # wait_for <seconds> <bash -c snippet>
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
job_program() { # program=/program identifier= of the loaded job, or empty
  launchctl print "gui/$(id -u)/com.nuncio.lilos.relay" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*program (identifier )?= ?([^ ]+).*/\2/p' | head -1 || true
}
quit_app() {
  pkill -f 'LilOS.app/Contents/MacOS/LilOS' 2>/dev/null || true
  wait_for 10 "! pgrep -f 'LilOS.app/Contents/MacOS/LilOS'" || true
}
launch_app() { # <app path> <log name>
  env LILOS_UPDATE_URL="http://127.0.0.1:1/update-feed.json" \
      LILOS_UPDATE_CHECK_MS=60000 \
      LILOS_STATE_DIR="$STATE_DIR" \
      "$1/Contents/MacOS/LilOS" >"$WORK/$2" 2>&1 &
}

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only"; exit 1; }

IDENTITY="${SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(.*\)"/\1/p' \
    | grep -E 'iPhone Distribution|Apple Development|Mac Developer|Developer ID Application' \
    | head -1)"
fi
[ -n "$IDENTITY" ] || { echo "no codesigning identity in keychain"; exit 1; }
step "signing identity: $IDENTITY"

# Clean slate: kill stray processes holding port 4577/4581, boot out any
# leftover agents, remove the user plists and the scratch dir.
quit_app
pkill -f 'LilOS.app/Contents/MacOS/lilos-(relay|harness|engine)' 2>/dev/null || true
lsof -ti :4577 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :4581 2>/dev/null | xargs kill -9 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.relay" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.nuncio.lilos.harness" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.nuncio.lilos."*.plist
rm -rf "$WORK"; mkdir -p "$WORK" "$STATE_DIR"

step "build ad-hoc v1.0.901 + signed v1.0.902 + ad-hoc v1.0.903"
"$BUN" apps/desktop/scripts/build.ts 901 - >/dev/null
ditto "$BUILD_DIST/LilOS.app" "$WORK/v901.app"
"$BUN" apps/desktop/scripts/build.ts 902 "$IDENTITY" >/dev/null
ditto "$BUILD_DIST/LilOS.app" "$WORK/v902.app"
"$BUN" apps/desktop/scripts/build.ts 903 - >/dev/null
ditto "$BUILD_DIST/LilOS.app" "$WORK/v903.app"
ok "built v901 ad-hoc, v902 signed, v903 ad-hoc"

# ---------------------------------------------------------------------------
step "AC-1 setup: install ad-hoc v901 at the app:local path and open it"
ditto "$WORK/v901.app" "$ADHOC_APP"
launch_app "$ADHOC_APP" app-901.log
if wait_for 90 "[ \"\$(healthz_version)\" = 1.0.901 ]"; then
  ok "ad-hoc v901 serving (/healthz = 1.0.901)"
else
  bad "ad-hoc v901 never came up"; tail -10 "$WORK/app-901.log" 2>/dev/null; exit 1
fi
[ -f "$HOME/Library/LaunchAgents/com.nuncio.lilos.relay.plist" ] \
  && ok "precondition: relay registered via user LaunchAgents plist (bootstrap path)" \
  || bad "precondition: no ~/Library/LaunchAgents relay plist"
P="$(job_program)"
case "$P" in
  "$ADHOC_APP/"*) ok "precondition: relay program runs from the ad-hoc bundle" ;;
  *) bad "precondition: relay program = $P (want $ADHOC_APP/...)";;
esac
quit_app

step "AC-1: install signed v902 at the DMG path and open it once"
ditto "$WORK/v902.app" "$SIGNED_APP"
launch_app "$SIGNED_APP" app-902.log
if wait_for 120 "[ \"\$(healthz_version)\" = 1.0.902 ]"; then
  ok "AC-1 relay+harness restarted from the signed bundle (/healthz = 1.0.902)"
else
  bad "AC-1 /healthz = $(healthz_version), want 1.0.902"
  tail -15 "$WORK/app-902.log" 2>/dev/null
fi
P="$(job_program)"
# SMAppService jobs report "program identifier = Contents/MacOS/lilos-relay"
# (relative into the registered bundle) — accept that too.
case "$P" in
  "$SIGNED_APP/"*|"Contents/MacOS/lilos-relay")
    ok "AC-1 relay program runs from the signed bundle ($P)" ;;
  *) bad "AC-1 relay program = $P (want $SIGNED_APP/...)";;
esac
if [ ! -e "$HOME/Library/LaunchAgents/com.nuncio.lilos.relay.plist" ] \
   && [ ! -e "$HOME/Library/LaunchAgents/com.nuncio.lilos.harness.plist" ]; then
  ok "AC-1 foreign user LaunchAgents plists removed"
else
  bad "AC-1 leftover ~/Library/LaunchAgents plists remain"
fi
quit_app

# ---------------------------------------------------------------------------
step "AC-2: ad-hoc v903 dropped over the signed install"
ditto "$WORK/v903.app" "$SIGNED_APP"
launch_app "$SIGNED_APP" app-903.log
if wait_for 90 "[ \"\$(healthz_version)\" = 1.0.903 ]"; then
  ok "AC-2 ad-hoc over signed re-registers (bootstrap path, /healthz = 1.0.903)"
else
  bad "AC-2 /healthz = $(healthz_version), want 1.0.903"
  tail -15 "$WORK/app-903.log" 2>/dev/null
fi
P="$(job_program)"
case "$P" in
  "$SIGNED_APP/"*) ok "AC-2 relay program runs from the ad-hoc bundle ($P)" ;;
  *) bad "AC-2 relay program = $P (want $SIGNED_APP/...)";;
esac
quit_app

step "summary"
for p in "${PASS[@]:-}"; do [ -n "$p" ] && echo "  PASS  $p"; done
for f in "${FAIL[@]:-}"; do [ -n "$f" ] && echo "  FAIL  $f"; done
[ "${#FAIL[@]}" -eq 0 ] && echo "LIVE PASS" || { echo "LIVE FAIL"; exit 1; }
