#!/usr/bin/env python3
"""LilOS stand-in MCP server (spike #23) — pure-stdlib stdio JSON-RPC.

Six tools mirroring the LilOS workbench surface an engine session would get:
browser_navigate, browser_snapshot, terminal_run, app_launch, file_stage,
notify. Every tools/call appends one JSON line to $LILOS_MCP_LOG
(default: ./mcp_calls.jsonl) and returns a `LILOS_MCP_HIT <tool> nonce=<n>`
text part so a transcript proves the call landed here.

No dependencies: speaks newline-delimited JSON-RPC 2.0 over stdio, which is
what MCP stdio transport is. Supports: initialize, notifications/*,
ping, tools/list, tools/call, resources/list, prompts/list.
"""

import json
import os
import sys
import time
import uuid

LOG = os.environ.get("LILOS_MCP_LOG") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "mcp_calls.jsonl"
)

TOOLS = [
    {
        "name": "browser_navigate",
        "description": "Open a URL in this LilOS session's dedicated browser tab. The tab is owned by the session and visible in the workbench pane.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Absolute URL to open, including scheme."}
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "browser_snapshot",
        "description": "Read the current state of this session's browser tab: URL, title, and the visible text content.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "terminal_run",
        "description": "Run a shell command in this session's terminal pane. Output streams live to the channel and is returned here.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute."},
                "timeout_seconds": {
                    "type": "integer",
                    "description": "Kill the command after this many seconds (default 30).",
                },
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "app_launch",
        "description": "Launch an app inside the LilOS desktop and attach it to this session's workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "app_name": {"type": "string", "description": "Registered app name, e.g. 'notes' or 'kanban'."}
            },
            "required": ["app_name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "file_stage",
        "description": "Stage a file into this session's scratch area so other tools (or teammates) can pick it up.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File name relative to the session scratch dir."},
                "contents": {"type": "string", "description": "UTF-8 text contents to write."},
            },
            "required": ["path", "contents"],
            "additionalProperties": False,
        },
    },
    {
        "name": "notify",
        "description": "Post a short notification into the LilOS channel this session is bound to.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Plain-text message to post."}
            },
            "required": ["message"],
            "additionalProperties": False,
        },
    },
]


def _log_call(tool: str, args: dict, nonce: str) -> None:
    rec = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "pid": os.getpid(),
        "tool": tool,
        "args": args,
        "nonce": nonce,
    }
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError as e:
        print(f"[lilos-mcp] log write failed: {e}", file=sys.stderr)


def _result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")

    if method == "initialize":
        return _result(req_id, {
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "lilos-workbench", "version": "0.0.1-spike"},
        })
    if method == "ping":
        return _result(req_id, {})
    if method == "tools/list":
        return _result(req_id, {"tools": TOOLS})
    if method == "resources/list":
        return _result(req_id, {"resources": []})
    if method == "prompts/list":
        return _result(req_id, {"prompts": []})
    if method == "tools/call":
        params = msg.get("params", {})
        name = params.get("name", "")
        args = params.get("arguments", {}) or {}
        nonce = uuid.uuid4().hex[:12]
        _log_call(name, args, nonce)
        if name not in {t["name"] for t in TOOLS}:
            return _result(req_id, {
                "isError": True,
                "content": [{"type": "text", "text": f"unknown tool {name!r}"}],
            })
        return _result(req_id, {
            "content": [{"type": "text", "text": f"LILOS_MCP_HIT {name} nonce={nonce} args={json.dumps(args, sort_keys=True)}"}],
        })

    if req_id is not None:
        return _error(req_id, -32601, f"method not found: {method}")
    return None  # notifications: no reply


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        out = _handle(msg)
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
