#!/usr/bin/env bash
# Issue #133 live check: on the ACP transport ("session carrying mcpServers"),
# answering "always" on an approval card must grant Hermes' permanent
# `allow_always` — the next session must not re-ask the same command.
#
# What runs for real in every mode: `hermes serve` + `hermes acp` (real
# binaries, real WS + ACP protocols), HermesEngine (the fixed acp.ts mapping),
# and the engine-conformance mcp_servers scenario end to end.
#
# Default run: deterministic local OpenAI-compatible stub provider in a
# scratch HERMES_HOME (no real LLM signed in on this VM — openai-codex signed
# out, OPENROUTER_API_KEY returns HTTP 401 "User not found").
#
# Real provider run (Oscar's Mac, e.g. HPC qwen / codex):
#   HERMES_PROVIDER=qwen HERMES_MODEL=<model> scripts/live/133-acp-always.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun scripts/live/133-acp-always.mts "$@"
