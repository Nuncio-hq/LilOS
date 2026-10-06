#!/usr/bin/env bash
# smoke-bins.sh <bins-dir> [repo-dir] — packaged-binary startup smoke (#539).
#
# Every compiled binary in <bins-dir> must START, not just compile: each is
# launched from a temp dir, and on CI the repo checkout is also moved aside,
# so a baked build-time path (the playwright-core package.json resolution
# that silently rolled back every Mac update since 1.0.33) fails here
# exactly the way it fails on a user's machine. Any startup error fails
# the smoke.
#
#   scripts/ci/smoke-bins.sh apps/desktop/build/smoke
#   scripts/ci/smoke-bins.sh apps/desktop/dist/LilOS.app/Contents/MacOS
#
# A bins dir inside an .app runs in-bundle (Contents/Resources/app/pw is
# part of what the smoke proves); anything else is copied to the temp dir.
#
# The repo hide is CI-ONLY (CI=true): build:harness is in verify:fast, which
# devs run in their working checkout — moving that tree out from under
# editors, dev stacks and other agents is not acceptable, and a killed run
# would leave it at <repo>.smoke-hidden. A CI runner checkout is disposable,
# so the full proof (baked-path + resolved-relative-path classes) happens
# there; locally the binaries still boot from a temp dir outside the repo,
# which already catches the baked-absolute-path class that caused #539.

if [ "${1:-}" != "--run" ]; then
  # Phase 1 — inside the repo: resolve paths and re-exec from a temp copy.
  # bash reads this script lazily; on CI the checkout is moved mid-run, so
  # the file at its original path must not be needed by then.
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

# Inside a bundle the Resources/app/pw tree is part of the proof: it is what
# the harness's lazy browser require resolves. Its absence must fail here,
# not at a user's first browser call.
if [ -d "$RUN/../Resources" ]; then
  if [ -f "$RUN/../Resources/app/pw/node_modules/playwright-core/package.json" ]; then
    ok "bundled playwright tree present (Resources/app/pw)"
  else
    bad "bundled playwright tree missing — packaged browser surface would fail at first call"
  fi
fi

# ---- hide the repo; restore on any exit ------------------------------------
PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  wait $PIDS 2>/dev/null
  if [ -d "$REPO.smoke-hidden" ]; then
    if [ -e "$REPO" ]; then
      # mv into a live dir would nest the stale tree inside the checkout.
      say "WARNING: $REPO and $REPO.smoke-hidden both exist — leaving the hidden copy for manual restore"
    else
      mv "$REPO.smoke-hidden" "$REPO" && say "repo restored"
    fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
# A smoke killed between hide and restore leaves the checkout hidden. The
# next run must recover or refuse — never move the live repo inside the
# stale one (mv would nest it, and cleanup would restore the wrong tree).
if [ -e "$REPO.smoke-hidden" ]; then
  if [ -e "$REPO" ]; then
    echo "smoke: $REPO.smoke-hidden already exists — a previous smoke died mid-hide; restore or remove it first" >&2
    exit 2
  fi
  mv "$REPO.smoke-hidden" "$REPO" || exit 2
  say "restored $REPO left hidden by a killed smoke run"
fi
if [ "${CI:-}" = "true" ]; then
  mv "$REPO" "$REPO.smoke-hidden" || { echo "smoke: cannot hide $REPO"; exit 2; }
  say "repo hidden — binaries run without their build-time checkout"
else
  say "local run — repo left in place (hide is CI-only); binaries still run from $RUN outside the checkout"
fi

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
# A dummy plistName carries it past the argc usage guard into the command
# dispatch, whose default arm prints "unknown command".
if have lilos-svc; then
  out="$(cd "$TMP" && "$RUN/lilos-svc" __smoke__ __smoke__.plist 2>&1)"
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

  # #551 AC-3: the packaged relay must answer a ws frame past Bun's old
  # 16 MiB default, not drop the socket. hello → messages.post with two
  # 9 MiB images (~25 MB base64) → ping; an answered post + ping proves
  # maxPayloadLength held on the embedded Bun.
  if [ -n "$RPORT" ] && [ -f "$TMP/relay-home/relay-token" ]; then
    cat >"$TMP/big-frame.ts" <<'TS'
const [port, token] = process.argv.slice(2);
const timer = setTimeout(() => {
  console.error("timeout waiting for the big-frame answer");
  process.exit(1);
}, 30_000);
const fail = (m: string): never => {
  clearTimeout(timer);
  console.error(m);
  process.exit(1);
};
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.addEventListener("close", (e) => fail(`socket closed ${e.code}`));
ws.addEventListener("error", () => fail("socket error"));
const send = (id: string, method: string, params: unknown) =>
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
const image = (n: number) => Buffer.alloc(n, 0x89).toString("base64");
ws.addEventListener("open", () =>
  send("h", "session.hello", { protocolVersion: 1, token }),
);
ws.addEventListener("message", (ev) => {
  const f = JSON.parse(String(ev.data)) as { id?: string; error?: unknown };
  if (f.error) fail(`${f.id}: ${JSON.stringify(f.error)}`);
  if (f.id === "h") {
    send("c", "employees.create", { name: "Smoke", role: "smoke" });
  } else if (f.id === "c") {
    const r = f as unknown as { result: { employee: { id: string } } };
    send("d", "channels.openDm", { employeeId: r.result.employee.id });
  } else if (f.id === "d") {
    const r = f as unknown as { result: { channel: { id: string } } };
    send("m", "messages.post", {
      channelId: r.result.channel.id,
      text: "two big screenshots",
      attachments: [
        { name: "a.png", mimeType: "image/png", dataBase64: image(9 * 1024 * 1024) },
        { name: "b.png", mimeType: "image/png", dataBase64: image(9 * 1024 * 1024) },
      ],
    });
  } else if (f.id === "m") {
    send("p", "session.ping", {});
  } else if (f.id === "p") {
    clearTimeout(timer);
    console.log(">16 MiB frame answered, socket alive");
    process.exit(0);
  }
});
TS
    if (cd "$TMP" && bun "$TMP/big-frame.ts" "$RPORT" "$(cat "$TMP/relay-home/relay-token")"); then
      ok "lilos-relay answered a >16 MiB ws frame"
    else
      bad "lilos-relay dropped a >16 MiB ws frame"
    fi
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

# lilos-engine-nous: the real engine adapter — hermes is absent on a CI box.
# Its own failure path is NOT to die: the supervisor logs the spawn error
# and keeps retrying with backoff, so a noisy process that stays up is
# correct; a bundled-path require or a silent clean exit is a crash shape.
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
  elif [ ! -s "$NLOG" ]; then
    bad "lilos-engine-nous exited silently"
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
