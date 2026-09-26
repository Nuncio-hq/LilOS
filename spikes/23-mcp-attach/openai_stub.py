#!/usr/bin/env python3
"""Local OpenAI-compatible /v1/chat/completions stub for spike #23.

Real provider credentials were unavailable on this VM (openai-codex signed
out, OpenRouter key 401s) so instead of a real LLM this stub drives Hermes'
REAL turn loop end-to-end through a `custom` provider endpoint:

  1st request (tools[] offered, no tool result yet):
      -> assistant tool_calls: mcp__lilos__terminal_run {command: "echo spike23"}
  next request (tool result with LILOS_MCP_HIT nonce in history):
      -> assistant text: "LILOS_MCP_OBSERVED nonce=<nonce>"
  request whose tools[] contains no mcp__lilos__* entries:
      -> assistant text: "NO_LILOS_TOOLS_OFFERED tools_count=<n>"

Every request is logged to wire_log.jsonl with the exact tool names Hermes
put on the wire and the serialized byte size of the `tools` field — that is
the token-cost measurement source. Handles both stream:true (SSE) and
non-streaming requests.

Usage: python3 openai_stub.py --port 8377 --log /path/wire.jsonl --dump /path/tools_dump.json
"""

import argparse
import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {"log": "wire.jsonl", "dump": "tools_dump.json", "seq": 0}

NONCE_RE = re.compile(r"LILOS_MCP_HIT \S+ nonce=([0-9a-f]+)")
CALL_TOOL = "mcp__lilos__terminal_run"
CALL_ARGS = {"command": "echo spike23-lilos"}


def _log(req_rec: dict) -> None:
    with LOCK, open(STATE["log"], "a", encoding="utf-8") as f:
        f.write(json.dumps(req_rec) + "\n")


def _tool_names(tools):
    out = []
    for t in tools or []:
        fn = (t or {}).get("function") or {}
        out.append(fn.get("name") or t.get("name") or "?")
    return out


def _find_hit_nonce(messages):
    for m in messages or []:
        if m.get("role") == "tool":
            content = m.get("content")
            if isinstance(content, list):
                content = " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
            hit = NONCE_RE.search(str(content or ""))
            if hit:
                return hit.group(1)
    return None


def _decide(body):
    """Return ('tool_call', None) | ('text', str)."""
    names = _tool_names(body.get("tools"))
    lilos = [n for n in names if n.startswith("mcp__lilos__")]
    nonce = _find_hit_nonce(body.get("messages"))
    if nonce:
        return "text", f"LILOS_MCP_OBSERVED nonce={nonce}"
    if lilos and CALL_TOOL in lilos:
        return "tool_call", None
    return "text", f"NO_LILOS_TOOLS_OFFERED tools_count={len(names)} lilos={lilos}"


def _json_completion(body, kind, text):
    msg = {"role": "assistant", "content": None, "tool_calls": None, "refusal": None}
    finish = "stop"
    if kind == "tool_call":
        msg["content"] = ""
        msg["tool_calls"] = [{
            "id": "call_" + uuid.uuid4().hex[:24],
            "type": "function",
            "function": {"name": CALL_TOOL, "arguments": json.dumps(CALL_ARGS)},
        }]
        finish = "tool_calls"
    else:
        msg["content"] = text
        msg.pop("tool_calls")
        msg.pop("refusal")
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "stub"),
        "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110},
    }


def _sse_completion(body, kind, text):
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    model = body.get("model", "stub")
    base = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
    chunks = []
    if kind == "tool_call":
        tc = {
            "index": 0, "id": "call_" + uuid.uuid4().hex[:24], "type": "function",
            "function": {"name": CALL_TOOL, "arguments": json.dumps(CALL_ARGS)},
        }
        chunks.append({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [tc]}, "finish_reason": None}]})
        chunks.append({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
    else:
        chunks.append({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]})
        chunks.append({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    if (body.get("stream_options") or {}).get("include_usage"):
        chunks.append({**base, "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}})
    payload = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)
    payload += "data: [DONE]\n\n"
    return payload.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence default stderr noise
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models") or self.path.endswith("/v1/models"):
            return self._send_json({"object": "list", "data": [
                {"id": "spike-stub-1", "object": "model", "created": 0, "owned_by": "spike"}]})
        return self._send_json({"error": {"message": f"unhandled GET {self.path}", "type": "stub"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._send_json({"error": {"message": "bad json", "type": "stub"}}, 400)

        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._send_json({"error": {"message": f"unhandled POST {self.path}", "type": "stub"}}, 404)

        tools = body.get("tools") or []
        names = _tool_names(tools)
        kind, text = _decide(body)
        with LOCK:
            STATE["seq"] += 1
            seq = STATE["seq"]
        rec = {
            "seq": seq, "ts": time.strftime("%H:%M:%S"), "model": body.get("model"),
            "stream": bool(body.get("stream")), "tools_count": len(names),
            "lilos_tools": [n for n in names if n.startswith("mcp__lilos__")],
            "tools_bytes": len(json.dumps(tools)), "n_messages": len(body.get("messages") or []),
            "decision": kind, "text": text,
        }
        _log(rec)
        if tools and seq <= 2:  # dump the exact tools array of the first requests
            with LOCK, open(STATE["dump"], "w", encoding="utf-8") as f:
                json.dump(tools, f, indent=1)

        if body.get("stream"):
            payload = _sse_completion(body, kind, text)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self._send_json(_json_completion(body, kind, text))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8377)
    ap.add_argument("--log", default="wire.jsonl")
    ap.add_argument("--dump", default="tools_dump.json")
    args = ap.parse_args()
    STATE["log"], STATE["dump"] = args.log, args.dump
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"openai-stub listening on 127.0.0.1:{args.port} log={args.log}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
