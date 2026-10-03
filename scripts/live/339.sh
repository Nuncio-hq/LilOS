#!/usr/bin/env bash
# Issue #339 live check: the Connect seam — plugin install+enable on a
# Hermes profile (the HermesConnect steps), lilos_* tools offered to a model
# inside a LilOS session and driven onto the session's PTY, inert outside.
#
# Default run: deterministic local OpenAI-compatible stub provider in a
# scratch HERMES_HOME (no real LLM signed in on this VM).
# Real provider run (Oscar's Mac):
#   HERMES_PROVIDER=qwen HERMES_MODEL=<model> scripts/live/339.sh
# (HERMES_PROFILE overrides the dedicated throwaway profile `l339live`.)
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun scripts/live/339.mts "$@"
