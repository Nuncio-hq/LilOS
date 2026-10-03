#!/usr/bin/env bash
# Issue #340 live check: the DM tools — a real relay + the harness's
# relay-backed appOps + `hermes acp` with the lilos plugin answer Oscar's
# four DM questions, retitle/post the thread, and open the Workbench.
#
# Default run: deterministic local OpenAI-compatible stub provider in a
# scratch HERMES_HOME (no real LLM signed in on this VM).
# Real provider run (Oscar's Mac):
#   HERMES_PROVIDER=qwen HERMES_MODEL=<model> scripts/live/340.sh
# (HERMES_PROFILE overrides the dedicated throwaway profile `l340live`.)
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun scripts/live/340.mts "$@"
