#!/usr/bin/env bash
# Issue #36 live check: LilOS MCP + CLI surfaces against real hermes acp
# (session/new { mcpServers } -> hermes spawns `lilos mcp`) plus a real MCP
# stdio leg and a real viewer WebSocket (the Workbench attach path).
#
# Default run: deterministic local OpenAI-compatible stub provider in a
# scratch HERMES_HOME (no real LLM signed in on this VM).
# Real provider run (Oscar's Mac):
#   HERMES_PROVIDER=qwen HERMES_MODEL=<model> scripts/live/36.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun scripts/live/36.mts "$@"
