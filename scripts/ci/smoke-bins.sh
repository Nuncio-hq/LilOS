#!/usr/bin/env bash
# smoke-bins.sh <bins-dir> [repo-dir] — packaged-binary startup smoke (#539).
#
# Every compiled binary in <bins-dir> must START, not just compile: each is
# launched from a temp dir while the repo checkout is moved aside, so a
# baked build-time path (the playwright-core package.json resolution that
# silently rolled back every Mac update since 1.0.33) fails here exactly
# the way it fails on a user's machine. Any startup error fails the smoke.
#
#   scripts/ci/smoke-bins.sh apps/desktop/build/smoke
#   scripts/ci/smoke-bins.sh apps/desktop/dist/LilOS.app/Contents/MacOS
#
# A bins dir inside an .app runs in-bundle (Contents/Resources/app/pw is
# part of what the smoke proves); anything else is copied to the temp dir.

if [ "${1:-}" != "--run" ]; then
  # Phase 1 — inside the repo: resolve paths and re-exec from a temp copy.
  # bash reads this script lazily; once the checkout is moved the file at
  # its original path is gone.
  BINDIR="$(cd "${1:?usage: smoke-bins.sh <bins-dir> [repo-dir]}" && pwd)" || exit 2
  SELF="$(cd "$(dirname "$0")" && pwd)"
  REPO="$(cd "${2:-"$SELF/../.."}" && pwd)" || exit 2
  TMP="$(mktemp -d)" || exit 1
  cp "$SELF/smoke-bins.sh" "$TMP/smoke-bins.sh" || exit 1
  exec bash "$TMP/smoke-bins.sh" --run "$BINDIR" "$REPO" "$TMP"
fi

BINDIR="$2"
REPO="$3"
TMP="$4"
set -u

say() { echo "smoke: $*"; }
FAIL=0
ok() { echo "smoke:   ok — $*"; }
bad() {
  echo "smoke: FAIL — $*"
  FAIL=1
}

# ---- stage the binaries under $TMP ----------------------------------------
case "$BINDIR" in
  */Contents/MacOS)
    APP="$(cd "$BINDIR/../.." && pwd)"
    cp -R "$APP" "$TMP/" || { bad "copy $APP"; exit 1; }
    RUN="$(cd "$TMP/$(basename "$APP")/Contents/MacOS" && pwd)"
    ;;
  *)
    mkdir -p "$TMP/bins"
    cp -R "$BINDIR/." "$TMP/bins/" || { bad "copy $BINDIR"; exit 1; }
    RUN="$TMP/bins"
    ;;
esac
say "staged at $RUN"

# ---- hide the repo; restore on any exit ------------------------------------
PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  wait $PIDS 2>/dev/null
  if [ -d "$REPO.smoke-hidden" ]; then
    mv "$REPO.smoke-hidden" "$REPO" && say "repo restored"
  fi
}
trap cleanup EXIT
mv "$REPO" "$REPO.smoke-hidden" || { echo "smoke: cannot hide $REPO"; exit 2; }
say "repo hidden — binaries run without their build-time checkout"

# ---- helpers ---------------------------------------------------------------
port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

# wait <logfile> <pattern> <pid> <name> [seconds] — boot-marker poll that also
# notices an early exit.
wait_for() {
  log="$1"; pat="$2"; pid="$3"; name="$4"; secs="${5:-20}"; i=0
  while [ "$i" -lt $((secs * 10)) ]; do
    grep -q "$pat" "$log" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || {
      sleep 0.2
      grep -q "$pat" "$log" 2>/dev/null
      return $?
    }
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}

# crash_sig <logfile> — a module-resolution failure: every legitimate bun
# error stack names /$bunfs frames, so the signature is only the "Cannot
# find" verdict (absolute-path requires and missing externals alike).
crash_sig() {
  grep -Eq "Cannot find (module|package)" "$1" 2>/dev/null
}

dump() { tail -8 "$1" | sed 's/^/smoke:   | /'; }

have() { [ -x "$RUN/$1" ]; }

# ---- per-binary checks -----------------------------------------------------
# lilos-svc: argv parser proves the binary ran its own code (macOS only).
if have lilos-svc; then
  out="$(cd "$TMP" && "$RUN/lilos-svc" __smoke__ 2>&1)"
  if crash_sig <(echo "$out"); then
    bad "lilos-svc — bundled-path crash"; echo "$out" | dump /dev/stdin
  elif echo "$out" | grep -q "unknown command"; then
    ok "lilos-svc ran (unknown-command path)"
  else
    bad "lilos-svc — unexpected: $out"
  fi
fi

# lilos-relay: boots, writes its install token, answers /healthz.
RPORT=""
if have lilos-relay; then
  RPORT="$(port)"
  RLOG="$TMP/relay.log"
  ( cd "$TMP" && \
    LILOS_RELAY_HOME="$TMP/relay-home" LILOS_RELAY_PORT="$RPORT" \
    "$RUN/lilos-relay" >"$RLOG" 2>&1 ) &
  RPID=$!; PIDS="$PIDS $RPID"
  if wait_for "$RLOG" "listening on http" "$RPID" lilos-relay 20 \
    && curl -fs "http://127.0.0.1:$RPORT/healthz" >/dev/null; then
    ok "lilos-relay booted + /healthz"
  else
    bad "lilos-relay did not boot"; dump "$RLOG"
  fi
fi

# lilos-engine-fake: an engine socket the smoke's own harness may also boot.
if have lilos-engine-fake; then
  FLOG="$TMP/engine-fake.log"
  ( cd "$TMP" && "$RUN/lilos-engine-fake" --port "$(port)" \
      >"$FLOG" 2>&1 ) &
  FPID=$!; PIDS="$PIDS $FPID"
  if wait_for "$FLOG" "LISTENING" "$FPID" lilos-engine-fake 20; then
    ok "lilos-engine-fake booted (LISTENING)"
  else
    bad "lilos-engine-fake did not boot"; dump "$FLOG"
  fi
fi

# lilos-engine-nous: the real engine adapter — hermes is absent on a CI box
# so it must die on its own error path, never on a bundled-path require.
if have lilos-engine-nous; then
  NLOG="$TMP/engine-nous.log"
  ( cd "$TMP" && env HERMES_BIN="$TMP/no-hermes" \
      "$RUN/lilos-engine-nous" >"$NLOG" 2>&1 ) &
  NPID=$!; PIDS="$PIDS $NPID"
  n=0
  while [ "$n" -lt 200 ] && kill -0 "$NPID" 2>/dev/null; do
    sleep 0.1; n=$((n + 1))
  done
  kill "$NPID" 2>/dev/null
  if crash_sig "$NLOG"; then
    bad "lilos-engine-nous — bundled-path crash"; dump "$NLOG"
  else
    ok "lilos-engine-nous ran its own code (no bundling crash)"
  fi
fi

# lilos-harness (and lilos-harness-check): the #539 leg — real boot against
# the smoke's relay + engine-fake, to the "harness up" marker + feed healthz.
for h in "$RUN"/lilos-harness*; do
  [ -x "$h" ] || continue
  name="$(basename "$h")"
  HLOG="$TMP/$name.log"
  FEED="$(port)"
  envs="LILOS_HARNESS_HOME=$TMP/harness-home LILOS_WORKDIR=$TMP LILOS_FEED_PORT=$FEED"
  if [ -n "$RPORT" ]; then
    envs="$envs LILOS_RELAY_HOME=$TMP/relay-home LILOS_RELAY_URL=ws://127.0.0.1:$RPORT/ws"
  fi
  if [ -f "$TMP/relay-home/relay-token" ]; then
    envs="$envs LILOS_RELAY_TOKEN=$(cat "$TMP/relay-home/relay-token")"
  fi
  if have lilos-engine-fake; then
    envs="$envs LILOS_ENGINE=fake"
  else
    envs="$envs LILOS_ENGINE=url LILOS_ENGINE_URL=ws://127.0.0.1:1/ws"
  fi
  ( cd "$TMP" && env $envs "$h" >"$HLOG" 2>&1 ) &
  HPID=$!; PIDS="$PIDS $HPID"
  if wait_for "$HLOG" "harness up" "$HPID" "$name" 25; then
    if curl -fs "http://127.0.0.1:$FEED/healthz" >/dev/null; then
      ok "$name reached 'harness up' + feed /healthz"
    else
      bad "$name — 'harness up' but feed /healthz failed"; dump "$HLOG"
    fi
  else
    bad "$name did not reach 'harness up'"; dump "$HLOG"
  fi
done

for p in $PIDS; do kill "$p" 2>/dev/null; done
if [ "$FAIL" = 0 ]; then
  say "all binaries started clean"
else
  say "smoke failed — see FAIL lines above"
fi
exit "$FAIL"
