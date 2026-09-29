#!/usr/bin/env python3
"""Deterministic OpenAI-compatible chat-completions stub for `bun run live:hermes`.

Used ONLY when no real provider is configured (CI / this VM has no signed-in
LLM). One HTTP server, stdlib only. Behaviour keyed on the last user message:

- contains "LILOS_SLOW"            -> ~24 slow chunks (interrupt window)
- contains "LILOS_LONG"           -> ~1200-word response (compression drive)
- contains "Fix the README title" -> tool_call `execute_code` (needs approval
                                     under hermes gateway), then a text turn
                                     once the tool result is in history
- contains "chmod 777"             -> tool_call `terminal` with that exact
                                     command — the same call a real model
                                     makes for the approval/resume prompts —
                                     emitted once (until a tool result lands),
                                     then a text turn
- contains "LILOS_DELEGATE"        -> tool_call `delegate_task` with a
                                     three-task batch (#179 subagents) once,
                                     then text after its result lands
- contains "LILOS_CHILD"          -> the spawned children: tool_call
                                     `terminal` echo once, then text — so a
                                     child tool call nests under the
                                     delegate call (parentToolCallId)
- contains "LILOS_BG"              -> tool_call `terminal` with
                                     background=true running `python3 -m
                                     http.server` (prints an http:// URL),
                                     then text
- contains "LILOS_BG_EXIT"         -> tool_call `terminal` background=true on
                                     a command that exits at once, then text
- contains "Explain the relay package" -> tool_call `read_file` (read-only,
                                     no approval), then text
- contains "Context builder"      -> "LILOS_OK" — since #76 the foldable
                                     mass is pasted in the USER turn (a real
                                     model only acks it), so the stub mirrors
                                     that instead of emitting long replies
- tools offered + tool result in history -> "LILOS_E2E_OK ..." text
- default                          -> "LILOS_E2E_OK <echo>" text

Every stream first sends an inline ``<think>`` block inside ``content`` so
hermes' think-block scrubber forwards it to the reasoning channel (the
chat_completions api_mode has no native reasoning-delta path).
"""
import argparse
import json
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {"log": "/tmp/lilos-hermes-stub.jsonl", "seq": 0}
NONCE = "7f00d"
DONE_RE = re.compile(r"LILOS_(TOOL_DONE|FILE_DONE)")
EDIT = "Fix the README title"
READ = "Explain the relay package"
CHMOD = "chmod 777"
CHMOD_COMMAND = "chmod 777 README.md"
DELEGATE = "LILOS_DELEGATE"
CHILD = "LILOS_CHILD"
BG = "LILOS_BG"
BG_EXIT = "LILOS_BG_EXIT"
# A long-running server whose banner carries an http://0.0.0.0 URL — the
# engine's URL sniffing reads it into the job row.
BG_COMMAND = "python3 -m http.server 8765 --bind 0.0.0.0"
# Lives ~1s first: a process that dies inside the spawn window never reaches
# the registry's running row, so the close/exit frame would never fire.
BG_EXIT_COMMAND = "sleep 1 && echo LILOS_BUILD_DONE"


def _log(rec):
    with LOCK, open(STATE["log"], "a") as f:
        f.write(json.dumps(rec) + "\n")


def _last_user(body):
    for m in reversed(body.get("messages") or []):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            return " ".join(str(x.get("text", "")) for x in c or [])
    return ""


def _tool_done(body):
    for m in body.get("messages") or []:
        if m.get("role") == "tool" and DONE_RE.search(str(m.get("content") or "")):
            return True
    return False


def _has_tool_result(body):
    return any(
        m.get("role") == "tool" for m in body.get("messages") or []
    )


def _decide(body):
    last = _last_user(body)
    if "LILOS_SLOW" in last:
        return "slow", "slow reply words for the interrupt window"
    if "LILOS_LONG" in last:
        return "text", " ".join(f"word{i}" for i in range(1200))
    # Compression fillers (#76): the foldable mass is the pasted text in the
    # user turn itself; a real model answers with a bare ack, so do the same.
    # This also fires for the aux summary call, which embeds the region.
    if "Context builder" in last:
        return "text", "LILOS_OK"
    if _tool_done(body):
        return "text", f"LILOS_E2E_OK {NONCE}"
    if body.get("tools"):
        if EDIT in last:
            return "tool_call", "execute_code"
        # One read: the tool result carries no marker, so without the
        # has-result guard this re-emits read_file until hermes' own
        # iteration cap ends the turn.
        if READ in last and not _has_tool_result(body):
            return "tool_call", "read_file"
        # chmod's stdout is empty, so no LILOS_TOOL_DONE marker ever lands;
        # gate on "no tool result yet" instead or this re-emits forever.
        if CHMOD in last and not _has_tool_result(body):
            return "tool_call", "terminal"
        # #179: one delegate batch / one background terminal per prompt,
        # then a plain-text finish once the tool result lands.
        if DELEGATE in last and not _has_tool_result(body):
            return "tool_call", "delegate_task"
        if CHILD in last and not _has_tool_result(body):
            return "tool_call", "terminal_child"
        # BG_EXIT before BG: "LILOS_BG" is a prefix of "LILOS_BG_EXIT".
        if BG_EXIT in last and not _has_tool_result(body):
            return "tool_call", "terminal_bg_exit"
        if BG in last and not _has_tool_result(body):
            return "tool_call", "terminal_bg"
    if (
        DELEGATE in last
        or BG_EXIT in last
        or BG in last
        or CHILD in last
    ):
        return "text", "LILOS_OK"
    return "text", "LILOS_E2E_OK " + last[:40]


def _tool_call(name):
    # terminal_bg* are scenario keys; the wire name is always `terminal`.
    wire = {
        "terminal_bg": "terminal",
        "terminal_bg_exit": "terminal",
        "terminal_child": "terminal",
    }.get(name, name)
    if name == "execute_code":
        args = {"code": f'print("LILOS_TOOL_DONE {NONCE}")'}
    elif name == "terminal":
        args = {"command": CHMOD_COMMAND}
    elif name == "delegate_task":
        args = {
            "tasks": [
                {"goal": "LILOS_CHILD scan the checkout", "context": "live-179"},
                {"goal": "LILOS_CHILD verify the findings", "context": "live-179"},
                {"goal": "LILOS_CHILD draft the summary", "context": "live-179"},
            ]
        }
    elif name == "terminal_child":
        args = {"command": "echo LILOS_CHILD_DONE"}
    elif name == "terminal_bg":
        args = {"command": BG_COMMAND, "background": True}
    elif name == "terminal_bg_exit":
        args = {
            "command": BG_EXIT_COMMAND,
            "background": True,
            "notify_on_complete": True,
        }
    else:
        args = {"path": "README.md"}
    return {
        "id": "call_" + uuid.uuid4().hex[:24],
        "type": "function",
        "function": {"name": wire, "arguments": json.dumps(args)},
    }




def _sse(body, kind, text):
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    model = body.get("model", "stub-1")
    base = {"id": cid, "object": "chat.completion.chunk",
            "created": int(time.time()), "model": model}
    head = [{**base, "choices": [{"index": 0, "delta": {
        "role": "assistant", "content": "<think>let me think step by step</think>"},
        "finish_reason": None}]}]
    if kind == "tool_call":
        tc = _tool_call(text)
        head.append({**base, "choices": [{"index": 0, "delta": {
            "tool_calls": [dict(tc, index=0)]}, "finish_reason": None}]})
        head.append({**base, "choices": [{"index": 0, "delta": {},
                                          "finish_reason": "tool_calls"}]})
        return "".join(f"data: {json.dumps(c)}\n\n" for c in head) + "data: [DONE]\n\n"
    if kind == "slow":
        words = text.split()
        out = list(head)
        for i in range(24):
            out.append({**base, "choices": [{"index": 0, "delta": {
                "content": words[i % len(words)] + " "}, "finish_reason": None}]})
        out.append({**base, "choices": [{"index": 0, "delta": {},
                                         "finish_reason": "stop"}]})
        return out  # caller writes chunk-by-chunk with delay
    out = head + [
        {**base, "choices": [{"index": 0, "delta": {"content": text},
                              "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]
    return "".join(f"data: {json.dumps(c)}\n\n" for c in out) + "data: [DONE]\n\n"


def _json_completion(body, kind, text):
    msg = {"role": "assistant", "content": None}
    finish = "stop"
    if kind == "tool_call":
        msg["content"] = ""
        msg["tool_calls"] = [_tool_call(text)]
        finish = "tool_calls"
    else:
        msg["content"] = text
    return {"id": "chatcmpl-" + uuid.uuid4().hex[:24],
            "object": "chat.completion", "created": int(time.time()),
            "model": body.get("model", "stub-1"),
            "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10,
                      "total_tokens": 110}}


class _Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Interrupted turns and keepalive probes drop sockets mid-stream;
        # only log real handler bugs.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _j(self, o, s=200):
        b = json.dumps(o).encode()
        self.send_response(s)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._j({"object": "list", "data": [
                {"id": "stub-1", "object": "model", "created": 0,
                 "owned_by": "lilos"}]})
        self._j({"error": {"message": "unhandled", "type": "stub"}}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._j({"error": {"message": "bad json", "type": "stub"}}, 400)
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._j({"error": {"message": "unhandled POST", "type": "stub"}}, 404)
        kind, text = _decide(body)
        with LOCK:
            STATE["seq"] += 1
            seq = STATE["seq"]
        _log({"seq": seq, "ts": time.strftime("%H:%M:%S"), "kind": kind,
              "stream": bool(body.get("stream")),
              "n_messages": len(body.get("messages") or []),
              "last_user": _last_user(body)[:80]})
        if body.get("stream"):
            r = _sse(body, kind, text)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if isinstance(r, list):
                for c in r:
                    self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.3)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                self.send_header("Content-Length", str(len(r.encode())))
                self.wfile.write(r.encode())
        else:
            self._j(_json_completion(body, kind, text))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8377)
    ap.add_argument("--log", default="/tmp/lilos-hermes-stub.jsonl")
    a = ap.parse_args()
    STATE["log"] = a.log
    print(f"openai_stub on 127.0.0.1:{a.port}", flush=True)
    _Server(("127.0.0.1", a.port), H).serve_forever()
