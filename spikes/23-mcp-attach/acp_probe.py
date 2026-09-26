#!/usr/bin/env python3
"""ACP probe for spike #23 — drives `hermes acp` over stdio.

Run with the Hermes-managed python (has the `acp` SDK):
  /Users/devin/.hermes/installs/.../venv/bin/python3 acp_probe.py --home ~/.hermes/profiles/spike23

Scenario:
  S1: session/new {mcpServers:[lilos stdio]} -> prompt -> expect Hermes to call
      mcp__lilos__terminal_run (stub LLM scripts it only when the tool is on the wire).
  S2: session/new {} (same process, same profile) -> prompt -> expect
      NO_LILOS_TOOLS_OFFERED (proves session scoping).

Prints a JSON verdict on stdout; everything interesting also lands in
wire.jsonl (from the stub) and mcp_calls.jsonl (from the MCP server).
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import acp
from acp.schema import McpServerStdio, EnvVariable

SPIKE_DIR = Path(__file__).resolve().parent
MCP_SERVER = SPIKE_DIR / "lilos_mcp_server.py"
MCP_LOG = SPIKE_DIR / "evidence" / "mcp_calls.jsonl"
HERMES = os.environ.get("HERMES_BIN", "/Users/devin/.local/bin/hermes")


class ProbeClient:
    """Minimal ACP client: records updates, auto-approves permissions."""

    def __init__(self):
        self.updates: list[dict] = []

    def on_connect(self, conn):
        self.conn = conn

    async def session_update(self, session_id, update, **kwargs):
        d = update.model_dump(by_alias=True) if hasattr(update, "model_dump") else dict(update)
        self.updates.append({"session": session_id, "update": d})
        kind = d.get("sessionUpdate")
        title = (d.get("title") or "")
        text = ((d.get("content") or {}).get("text") if isinstance(d.get("content"), dict) else d.get("text")) or ""
        line = f"  [update] {kind} {title} {text[:120]}"
        print(line, flush=True)

    async def request_permission(self, options, session_id, tool_call, **kwargs):
        allow = next((o for o in options if "allow" in (o.option_id or "")), options[0])
        print(f"  [perm] {tool_call.title if hasattr(tool_call,'title') else tool_call} -> {allow.option_id}", flush=True)
        return acp.RequestPermissionResponse(outcome=acp.schema.AllowedOutcome(optionId=allow.option_id))

    async def read_text_file(self, path, session_id, limit=None, line=None, **kwargs):
        return acp.ReadTextFileResponse(content=Path(path).read_text())

    async def write_text_file(self, content, path, session_id, **kwargs):
        Path(path).write_text(content)
        return acp.WriteTextFileResponse()

    async def create_terminal(self, command, session_id, args=None, cwd=None, env=None, output_byte_limit=None, **kwargs):
        raise acp.RequestError(-32601, "terminal not supported by probe")

    async def terminal_output(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError(-32601, "n/a")

    async def wait_for_terminal_exit(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError(-32601, "n/a")

    async def kill_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError(-32601, "n/a")

    async def release_terminal(self, session_id, terminal_id, **kwargs):
        raise acp.RequestError(-32601, "n/a")

    async def ext_method(self, method, params):
        raise acp.RequestError(-32601, f"unknown ext method {method}")

    async def ext_notification(self, method, params):
        pass


async def run(home: str, prompt_text: str) -> dict:
    env = dict(os.environ)
    env["HERMES_HOME"] = home
    env["HERMES_ACP_SKIP_CONFIGURED_MCP"] = "0"
    result = {"home": home, "sessions": []}

    async with acp.spawn_agent_process(
        ProbeClient(), HERMES, "acp",
        env=env, cwd=str(SPIKE_DIR), use_unstable_protocol=True,
    ) as (conn, proc):
        print("[probe] hermes acp spawned, initializing...", flush=True)
        init = await conn.initialize(
            protocol_version=acp.PROTOCOL_VERSION,
            client_info=acp.schema.Implementation(name="lilos-spike-probe", version="0.0.1"),
        )
        result["initialize"] = init.model_dump(by_alias=True)
        print(f"[probe] init ok agent={result['initialize'].get('agentInfo')}", flush=True)

        # --- S1: session WITH the LilOS MCP server -----------------------------
        s1 = await conn.new_session(
            cwd=str(SPIKE_DIR),
            mcp_servers=[McpServerStdio(
                name="lilos",
                command=sys.executable if sys.executable else "python3",
                args=[str(MCP_SERVER)],
                env=[EnvVariable(name="LILOS_MCP_LOG", value=str(MCP_LOG))],
            )],
        )
        s1_id = s1.session_id
        print(f"[probe] S1 session_id={s1_id} (with mcpServers)", flush=True)
        r1 = await conn.prompt(session_id=s1_id, prompt=[acp.text_block(prompt_text)])
        result["sessions"].append({"id": s1_id, "mcp": True, "stop_reason": r1.stop_reason})

        # --- S2: session WITHOUT (same process, same profile) ------------------
        s2 = await conn.new_session(cwd=str(SPIKE_DIR), mcp_servers=[])
        s2_id = s2.session_id
        print(f"[probe] S2 session_id={s2_id} (no mcpServers)", flush=True)
        r2 = await conn.prompt(session_id=s2_id, prompt=[acp.text_block(prompt_text)])
        result["sessions"].append({"id": s2_id, "mcp": False, "stop_reason": r2.stop_reason})

        # --- close both cleanly -------------------------------------------------
        for sid in (s1_id, s2_id):
            try:
                await conn.close_session(sid)
            except Exception:
                pass

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--prompt", default="Run the spike check.")
    args = ap.parse_args()
    out = asyncio.run(run(args.home, args.prompt))
    print("\n=== PROBE RESULT ===")
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
