#!/usr/bin/env bash
# Issue #337 live check: the agent gateway over streamable-HTTP MCP — one
# catalog (GET /tools), session binding (bearer + engine-id alias), the host
# policy in initialize, and real hermes acp session/new for the stdio attach.
#
# Default run: deterministic local OpenAI-compatible stub provider in a
# scratch HERMES_HOME (no real LLM signed in on this VM).
# Real provider run (Oscar's Mac):
#   HERMES_PROVIDER=qwen HERMES_MODEL=<model> scripts/live/337.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun scripts/live/337.mts "$@"
