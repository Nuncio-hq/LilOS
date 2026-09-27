#!/usr/bin/env bash
# Issue #85 live leg — the release engine is real Hermes.
#
#   bash scripts/live/85-real-engine.sh [dev|app]
#
#   dev (default): repo relay + harness with LILOS_ENGINE unset — proves the
#       harness's own default launches `hermes serve` (found without PATH via
#       the new discovery), then a DM round-trip answers.
#   app:           full packaged leg — build LilOS.dmg with
#       scripts/release/sign-local.sh, install + launch the app, and send a
#       DM through the installed relay (drive-turn.ts) until a reply lands.
#       On Oscar's Mac this is the AC-1 run: signed DMG -> real model.
#
# Provider selection:
#   HERMES_PROVIDER + HERMES_MODEL set -> "live" mode (your signed-in engine).
#   Unset -> "stub" mode: a deterministic OpenAI stub is registered as the
#   `lilos-stub` provider and pinned via HERMES_* env (dev leg) or injected
#   EnvironmentVariables in the harness launch-agent plist (app leg). The
#   run is labeled stub — it is never a live-model result.
#
# Prints PASS/FAIL. Exit 0 only on PASS.
set -u
cd "$(dirname "$0")/../.."
ROOT="$PWD"
export PATH="$HOME/.bun/bin:$PATH"
# Deliberately NOT adding ~/.local/bin — the harness must find hermes there
# on its own (AC-2).

MODE="${1:-dev}"
STUB_PORT=8377
LABEL=live
if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  LABEL="live (${HERMES_PROVIDER}/${HERMES_MODEL})"
else
  LABEL="stub (openai-compatible stub @127.0.0.1:${STUB_PORT})"
  export HERMES_PROVIDER=lilos-stub
  export HERMES_MODEL=stub-1
fi

STUB_PID=""
CONFIG_BACKUP=""
CONFIG_CREATED=""
HERMES_CONFIG=~/.hermes/config.yaml
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  if [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$HERMES_CONFIG"
  elif [ -n "$CONFIG_CREATED" ]; then
    rm -f "$HERMES_CONFIG"
  fi
  if [ "$MODE" = "dev" ]; then
    pkill -f "live-85-real-engine.ts" 2>/dev/null
    pkill -f "apps/harness/src/index.ts" 2>/dev/null
    pkill -f "apps/relay/src/index.ts" 2>/dev/null
    pkill -f "packages/engine-hermes/scripts/serve.ts" 2>/dev/null
    pkill -f "hermes_bootstrap.*serve --host" 2>/dev/null
  fi
  true
}
trap cleanup EXIT

if [ "$MODE" != "dev" ] && [ "$MODE" != "app" ]; then
  echo "usage: $0 [dev|app]"; exit 2
fi

# ── stub mode: provision the lilos-stub provider ─────────────────────────
if [ "$LABEL" != "${LABEL#stub}" ]; then
  command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ] || {
    echo "LIVE_ENGINE_UNAVAILABLE: no hermes binary at ~/.local/bin/hermes or on PATH"
    exit 2
  }
  bun scripts/live/openai-stub.ts "$STUB_PORT" >/tmp/openai-stub-85.log 2>&1 &
  STUB_PID=$!
  sleep 0.5
  mkdir -p "$HOME/.hermes"
  if [ -f "$HERMES_CONFIG" ]; then
    CONFIG_BACKUP="/tmp/hermes-config-backup85.$$"
    cp "$HERMES_CONFIG" "$CONFIG_BACKUP"
  else
    CONFIG_CREATED=1
    touch "$HERMES_CONFIG"
  fi
  if ! grep -q "lilos-stub:" "$HERMES_CONFIG"; then
    cat >> "$HERMES_CONFIG" <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
    discover_models: false
    models:
      - stub-1
      - stub-2
EOF
  fi
fi

echo "== issue-85 live leg: default engine + DM round-trip (mode=${MODE}, label=${LABEL}) =="

if [ "$MODE" = "dev" ]; then
  if bun apps/harness/scripts/live-85-real-engine.ts; then
    echo "RESULT: PASS (label=${LABEL})"
    exit 0
  fi
  echo "RESULT: FAIL (label=${LABEL})"
  exit 1
fi

# ── app mode: signed build -> install -> DM through the packaged relay ───
DMG_VERSION="${LILOS_DMG_VERSION:-85}"
LILOS_STATE="${LILOS_HOME:-$HOME/.lilos}"

echo "==> build DMG (scripts/release/sign-local.sh)"
bash scripts/release/sign-local.sh "$DMG_VERSION" || exit 1
DMG="$(ls -t apps/desktop/dist/*.dmg | head -1)"
[ -n "$DMG" ] || { echo "RESULT: FAIL (no dmg produced)"; exit 1; }
echo "built $DMG"
# AC-1: a release bundle must not contain the fake engine.
# The volume name has a space ("LilOS 1.0.85"): take everything from
# /Volumes/ on, not a whitespace-split field.
MOUNT=$(hdiutil attach -nobrowse -readonly "$DMG" | grep -o '/Volumes/.*' | head -1)
[ -n "$MOUNT" ] || { echo "RESULT: FAIL (dmg did not mount)"; exit 1; }
if [ -e "$MOUNT/LilOS.app/Contents/MacOS/lilos-engine-fake" ]; then
  echo "RESULT: FAIL (lilos-engine-fake is inside the bundle)"
  hdiutil detach "$MOUNT" >/dev/null 2>&1; exit 1
fi
[ -e "$MOUNT/LilOS.app/Contents/MacOS/lilos-engine-hermes" ] || {
  echo "RESULT: FAIL (no lilos-engine-hermes in the bundle)"
  hdiutil detach "$MOUNT" >/dev/null 2>&1; exit 1; }
echo "bundle check: lilos-engine-hermes present, no fake engine"

# In stub mode the packaged harness still needs the provider envs — inject
# them into its launch-agent plist inside the mounted bundle, then install.
if [ "$LABEL" != "${LABEL#stub}" ]; then
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' \
    "$MOUNT/LilOS.app/Contents/Library/LaunchAgents/com.nuncio.lilos.harness.plist" 2>/dev/null
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:HERMES_PROVIDER string lilos-stub' \
    "$MOUNT/LilOS.app/Contents/Library/LaunchAgents/com.nuncio.lilos.harness.plist"
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:HERMES_MODEL string stub-1' \
    "$MOUNT/LilOS.app/Contents/Library/LaunchAgents/com.nuncio.lilos.harness.plist"
  # A read-only dmg can't take the edited plist — copy the .app off first.
fi

rm -rf /tmp/LilOS-85.app
cp -R "$MOUNT/LilOS.app" /tmp/LilOS-85.app
hdiutil detach "$MOUNT" >/dev/null 2>&1
# (re-sign ad-hoc: copying broke any signature on the edited plist's seal)
codesign --force --deep --sign - /tmp/LilOS-85.app 2>/dev/null || true
mkdir -p ~/Applications
rm -rf ~/Applications/LilOS.app
cp -R /tmp/LilOS-85.app ~/Applications/LilOS.app

echo "==> launch installed app"
killall LilOS 2>/dev/null; sleep 1
open ~/Applications/LilOS.app
# Wait for the relay to come up and write its token.
for i in $(seq 1 120); do
  [ -f "$LILOS_STATE/relay-token" ] && break
  sleep 1
done
[ -f "$LILOS_STATE/relay-token" ] || { echo "RESULT: FAIL (relay never came up)"; exit 1; }
echo "relay up"

echo "==> status legs (installed relay)"
for i in $(seq 1 60); do
  STATUS=$(bun apps/desktop/scripts/probe-status.ts 2>/dev/null || true)
  echo "$STATUS" | grep -q '"name":"engine-hermes"' && break
  echo "$STATUS" | grep -q '"name":"engine-fake"' && {
    echo "RESULT: FAIL (installed app is running engine-fake — label=${LABEL})"
    exit 1
  }
  sleep 2
done
echo "$STATUS" | grep -q '"name":"engine-hermes"' || {
  echo "RESULT: FAIL (engine never reported engine-hermes; last status: $STATUS)"
  exit 1
}
echo "engine leg: engine-hermes ok"

echo "==> DM round-trip via drive-turn"
bun apps/desktop/scripts/drive-turn.ts open "Reply with the single word READY" || exit 1
# The engine may gate on an approval ask — answer any open ones, then wait.
for i in $(seq 1 90); do
  bun apps/desktop/scripts/drive-turn.ts approve >/dev/null 2>&1 || true
  MSGS=$(bun apps/desktop/scripts/drive-turn.ts messages 2>/dev/null || true)
  echo "$MSGS" | grep -q '"author": "employee"' && break
  sleep 2
done
echo "$MSGS"
echo "$MSGS" | grep -q '"author": "employee"' || {
  echo "RESULT: FAIL (no employee reply in 180s; label=${LABEL})"
  exit 1
}
echo "RESULT: PASS (packaged LilOS.app DM answered by engine-hermes; label=${LABEL})"
exit 0
