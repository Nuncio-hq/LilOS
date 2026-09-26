#!/usr/bin/env bash
# Issue #8 live check: the `agents` + `models` capability surface against a real
# `hermes serve` gateway (WS /api/ws, real profiles.* / model.options / slash.exec
# / prompt.submit calls — nothing simulated).
#
# Default run (no env): a deterministic local OpenAI-compatible stub provider is
# registered as a `custom_providers` entry in a scratch HERMES_HOME. Clearly a
# stub: no real LLM is signed in on this VM.
#
# Real provider run (Oscar's Mac): export HERMES_PROVIDER + HERMES_MODEL for a
# provider already configured in the real ~/.hermes — e.g.
#   HERMES_PROVIDER=qwen HERMES_MODEL=qwen3.8-flash-next scripts/live/8.sh
# (optionally HERMES_HOME=<path> to override the home).
#
# Prints a pass/fail summary and the throwaway profile name (left on disk —
# LilOS never deletes engine profiles).
set -euo pipefail
cd "$(dirname "$0")/../.."
exec python3 scripts/live/8.py "$@"
