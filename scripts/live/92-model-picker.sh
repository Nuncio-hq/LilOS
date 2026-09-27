#!/usr/bin/env bash
# Issue #92 live leg: model picker v2 — pick {provider?, id} + effort + fast;
# the next turn answers on them; refresh + LilOS-owned hide list round-trip.
#
# Default (this VM): no signed-in LLM — hermes is pointed at a deterministic
# OpenAI-compatible stub (scripts/live/openai-stub.ts; models stub-1, stub-2,
# stub/group-1 — the "/" id exercises AC-8 for real) and the run is labeled
# "stub". To rerun against a real model on Oscar's Mac (e.g. switch HPC qwen
# <-> a codex model):
#
#   HERMES_PROVIDER=<named provider in hermes config> \
#   HERMES_MODEL=<model> \
#   bash scripts/live/92-model-picker.sh
#
# Isolation rules (never violated):
#   * the run works on a throwaway HERMES_HOME copied from the real one —
#     ~/.hermes/config.yaml is never edited, the temp copy is removed on exit;
#   * the only processes killed are the ones this script (and its ts driver)
#     spawned — no pkill, nothing the user had running is touched.
#
# What it does:
#   1. starts a real relay + the real harness (apps/harness, LILOS_ENGINE=hermes)
#   2. the harness spawns packages/engine-hermes serve.ts -> `hermes serve`
#      (HERMES_HOME inherits to it, so the engine reads the temp config)
#   3. a scripted user (apps/harness/scripts/live-92-model-picker.ts) reads
#      the engine catalog + providers off system.status, calls
#      models.list {refresh:true}, settings.set/get (the Edit-models store),
#      sends conversations.setModel with the full pick, then a prompt, and
#      asserts the answer message carries model + effort + fast
#   4. PASS/FAIL summary on stdout
set -u
cd "$(dirname "$0")/../.."
ROOT="$PWD"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

command -v hermes >/dev/null 2>&1 || {
  echo "LIVE_ENGINE_UNAVAILABLE: hermes not on PATH"
  exit 2
}

LABEL=stub
if [ -n "${HERMES_PROVIDER:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  LABEL="live (${HERMES_PROVIDER}/${HERMES_MODEL})"
fi

# Throwaway engine state: config.yaml + .env + auth.json (signed-in providers
# for the live leg) copied in, never the real files. Deleted on exit.
# NOTE: HERMES_RUNTIME_DIR is NOT overridden — an empty one breaks the
# toolchain lookup entirely.
HERMES_HOME="$(mktemp -d "${TMPDIR:-/tmp}/lilos92-hermes-home.XXXXXX")"
export HERMES_HOME
for f in config.yaml .env auth.json; do
  [ -f "$HOME/.hermes/$f" ] && cp "$HOME/.hermes/$f" "$HERMES_HOME/$f"
done
[ -f "$HERMES_HOME/config.yaml" ] || : > "$HERMES_HOME/config.yaml"
# The `hermes` launcher resolves its managed python as $HERMES_HOME/tools/…
# and REWRITES the real ~/.hermes/.../bin/hermes shim to that path on every
# boot. Symlink the toolchain so the repointed shim keeps working while this
# run lives, and snapshot the shims to restore on exit — the real install is
# left untouched either way.
ln -s "$HOME/.hermes/tools" "$HERMES_HOME/tools" 2>/dev/null || true
SHIM_DIR="$HOME/.hermes/hermes-agent/.hermes/bin"
SHIM_BAK="$(mktemp -d "${TMPDIR:-/tmp}/lilos92-shims.XXXXXX")"
for s in hermes hermes-acp; do
  [ -f "$SHIM_DIR/$s" ] && cp "$SHIM_DIR/$s" "$SHIM_BAK/$s"
done

# ── SIGKILL warning ────────────────────────────────────────────────────
# A SIGKILL never runs the trap: the `hermes`/`hermes-acp` shims under
# ~/.hermes/hermes-agent/.hermes/bin keep pointing at this run's temp
# HERMES_HOME — which no longer exists, so `hermes` breaks for EVERYTHING.
# Fix: restore the backups this run took, e.g.
#   cp <SHIM_BAK printed below>/hermes* ~/.hermes/hermes-agent/.hermes/bin/
# (or just re-run `hermes` once with HERMES_HOME unset — the launcher
# rewrites the shim back to the real toolchain on the next normal boot).
cat <<EOF
NOTE: hermes shims are temporarily repointed at $HERMES_HOME
      (backups in $SHIM_BAK). If this script is SIGKILLed, restore them:
      cp $SHIM_BAK/hermes* $SHIM_DIR/
EOF

STUB_PORT=""
STUB_PID=""
STUB_REQ_LOG="/tmp/openai-stub-92-requests.jsonl"
cleanup() {
  # Only what this script started — relay/harness/hermes are the ts driver's
  # own process groups and it reaps them itself.
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  # OAuth refresh tokens rotate: if the run rewrote the copied auth.json,
  # carry it back to the real home so the rotated token isn't lost. Only
  # auth.json — config.yaml is never written back (the temp file holds the
  # stub provider block, not the user's real config).
  if [ -f "$HERMES_HOME/auth.json" ] && ! cmp -s "$HERMES_HOME/auth.json" "$HOME/.hermes/auth.json" 2>/dev/null; then
    cp "$HERMES_HOME/auth.json" "$HOME/.hermes/auth.json"
    echo "(auth.json changed during the run — synced back to ~/.hermes)"
  fi
  # The launcher repoints the real shims at this run's home — put them back.
  for s in hermes hermes-acp; do
    [ -f "$SHIM_BAK/$s" ] && cp "$SHIM_BAK/$s" "$SHIM_DIR/$s"
  done
  rm -rf "$HERMES_HOME" "$SHIM_BAK"
}
trap cleanup EXIT

if [ "$LABEL" = "stub" ]; then
  # Port 0 → kernel picks; the bound port comes back on the stub's first
  # stdout line so a stale process can never shadow it.
  : > "$STUB_REQ_LOG"
  STUB_REQUEST_LOG="$STUB_REQ_LOG" bun scripts/live/openai-stub.ts 0 >/tmp/openai-stub-92.log 2>&1 &
  STUB_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    STUB_PORT="$(sed -n 's/.*127.0.0.1:\([0-9]*\).*/\1/p' /tmp/openai-stub-92.log | head -1)"
    [ -n "$STUB_PORT" ] && break
    sleep 0.3
  done
  [ -n "$STUB_PORT" ] || {
    echo "FAIL: stub never bound a port — /tmp/openai-stub-92.log:"
    cat /tmp/openai-stub-92.log
    exit 1
  }
  # Register the stub as a named provider with three models (one "/" id for
  # AC-8) — on the TEMP config only.
  if ! grep -q "lilos-stub:" "$HERMES_HOME/config.yaml"; then
    cat >> "$HERMES_HOME/config.yaml" <<EOF
providers:
  lilos-stub:
    base_url: "http://127.0.0.1:${STUB_PORT}/v1"
    api_mode: chat_completions
    api_key: "stub"
    # declared list is the whole catalog (discover_models off) — the picker
    # needs >=2 entries to switch between and the stub serves any id.
    discover_models: false
    models:
      - stub-1
      - stub-2
      - stub/group-1
EOF
  fi
  export HERMES_PROVIDER=lilos-stub
  export HERMES_MODEL=stub-1
fi

export LILOS_ENGINE=hermes
export LILOS_REPO_ROOT="$ROOT"
# The stub records each request's model/service_tier/speed/reasoning_effort
# so the driver can prove the pick (incl. the live fast leg) reached the
# wire — on the stub leg only; a real provider can't be introspected.
export STUB_REQUEST_LOG_FILE="$STUB_REQ_LOG"

echo "== issue-92 live leg: model picker v2 -> next turn (engine=hermes, label=${LABEL}) =="
if bun apps/harness/scripts/live-92-model-picker.ts; then
  echo "RESULT: PASS (engine=hermes, label=${LABEL})"
else
  echo "RESULT: FAIL (engine=hermes, label=${LABEL})"
  exit 1
fi
