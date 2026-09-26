#!/usr/bin/env python3
"""Spike #22: local OpenAI-compatible model stub (chat.completions, SSE).

PURPOSE: this VM has no working provider credential (openai-codex logged out,
OpenRouter key 401s), and the VM cannot sleep anyway, so the model link is the
one piece this spike legitimately stubs. Everything else (hermes serve, agent
loop, terminal tool, WS gateway) is the real Hermes pipeline.

Behaviour:
- POST /v1/chat/completions, stream=true -> SSE chunks.
- If the conversation already contains a role:"tool" message (tool result
  came back): stream a final answer. If the request JSON contains the marker
  "SLOWFINAL", emit ~45 chunks 2s apart (~90s of stream) so a freeze can land
  mid-provider-response; otherwise fast.
- If the latest user message contains "SLEEP:<n>" -> emit a tool_call to the
  `terminal` tool running `sleep <n>` (foreground, real sleep on the box).
- Anything else -> short text reply.
- GET /v1/models -> minimal model list.
- GET /admin/close -> shutdown() every currently-open SSE connection, so the
  peer sees ECONNRESET/EOF on resume. Used to model a provider TCP link that
  died while the machine was asleep.
- GET /admin/state -> JSON {open_sockets, request_count}.

Every request/chunk is appended to stub.log with wall+mono timestamps.
"""

import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open("/Users/devin/spike22/stub.log", "a", buffering=1)
ACTIVE: "list[socket.socket]" = []
ACTIVE_LOCK = threading.Lock()
REQ_COUNT = 0


def log(ev):
    LOG.write(json.dumps({"t_wall": time.time(), "t_mono": time.monotonic(), **ev}) + "\n")


class _Chunked:
    """HTTP/1.1 chunked-transfer writer over the raw socket stream."""

    def __init__(self, wfile):
        self.wfile = wfile
        self.done = False

    def write(self, data):
        if isinstance(data, str):
            data = data.encode()
        if not data:
            return
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")

    def flush(self):
        self.wfile.flush()

    def finish(self):
        if not self.done:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            self.done = True


def chunk(cid, model, delta, finish=None):
    c = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(c)}\n\n"


def stream_text(wfile, cid, model, text, slow=False):
    """Stream `text` as small deltas; returns False if the client went away."""
    words = text.split(" ")
    if slow:
        n = max(30, len(words) * 8)
        pieces = []
        per = max(1, len(text) // n)
        for i in range(0, len(text), per):
            pieces.append(text[i:i + per])
        for i, piece in enumerate(pieces):
            try:
                wfile.write(chunk(cid, model, {"content": piece}))
                wfile.flush()
                log({"ev": "chunk_sent", "i": i, "of": len(pieces)})
            except Exception as e:
                log({"ev": "chunk_send_failed", "i": i, "err": repr(e)})
                return False
            time.sleep(2.0)
    else:
        for w in words:
            try:
                wfile.write(chunk(cid, model, {"content": w + " "}))
                wfile.flush()
            except Exception as e:
                log({"ev": "chunk_send_failed", "err": repr(e)})
                return False
            time.sleep(0.02)
    return True


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _track(self):
        with ACTIVE_LOCK:
            ACTIVE.append(self.connection)

    def _untrack(self):
        with ACTIVE_LOCK:
            if self.connection in ACTIVE:
                ACTIVE.remove(self.connection)

    def do_GET(self):
        global REQ_COUNT
        if self.path == "/admin/close":
            with ACTIVE_LOCK:
                conns = list(ACTIVE)
            n = 0
            for s in conns:
                try:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, 0)
                    s.close()
                    n += 1
                except Exception:
                    pass
            log({"ev": "admin_close", "closed": n})
            self._json(200, {"closed": n})
            return
        if self.path == "/admin/state":
            with ACTIVE_LOCK:
                n = len(ACTIVE)
            self._json(200, {"open_sockets": n, "request_count": REQ_COUNT})
            return
        if self.path.startswith("/v1/models"):
            self._json(200, {"object": "list", "data": [
                {"id": "spike-model", "object": "model", "created": 0, "owned_by": "stub"}]})
            return
        self._json(404, {"error": "no route"})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global REQ_COUNT
        if not self.path.startswith("/v1/chat/completions"):
            self._json(404, {"error": "no route"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        REQ_COUNT += 1
        reqno = REQ_COUNT
        try:
            req = json.loads(raw)
        except Exception:
            self._json(400, {"error": "bad json"})
            return
        model = req.get("model") or "spike-model"
        msgs = req.get("messages") or []
        want_stream = bool(req.get("stream"))
        has_tool_result = any(m.get("role") == "tool" for m in msgs)
        last_user = ""
        for m in reversed(msgs):
            if m.get("role") == "user":
                last_user = m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content"))
                break
        slow_final = "SLOWFINAL" in raw.decode("utf-8", "ignore")
        log({"ev": "request_start", "req": reqno, "model": model,
             "n_messages": len(msgs), "stream": want_stream,
             "has_tool_result": has_tool_result, "slow_final": slow_final,
             "last_user_tail": last_user[-80:]})

        cid = f"chatcmpl-spike-{reqno}"
        if want_stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._track()
            wfile = _Chunked(self.wfile)
            try:
                if has_tool_result:
                    text = ("SLEEP_SURVIVED: the terminal sleep tool finished and the stub model "
                            "answered the follow-up call. Turn complete.")
                    ok = stream_text(wfile, cid, model, text, slow=slow_final)
                    if ok:
                        wfile.write("data: " + json.dumps({
                            "id": cid, "object": "chat.completion.chunk",
                            "created": int(time.time()), "model": model,
                            "choices": [{"index": 0, "delta": {},
                                         "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 10, "completion_tokens": 20,
                                      "total_tokens": 30}}) + "\n\n")
                        wfile.write("data: [DONE]\n\n")
                elif "SLEEP:" in last_user:
                    secs = 120
                    import re
                    m = re.search(r"SLEEP:(\d+)", last_user)
                    if m:
                        secs = int(m.group(1))
                    args = json.dumps({"command": f"sleep {secs}", "timeout": secs + 30})
                    # Emit the tool_call in a few chunks like a real stream.
                    wfile.write(chunk(cid, model, {"role": "assistant"}))
                    wfile.flush()
                    time.sleep(0.3)
                    wfile.write(chunk(cid, model, {"tool_calls": [
                        {"index": 0, "id": f"call_sleep_{reqno}", "type": "function",
                         "function": {"name": "terminal", "arguments": ""}}]}))
                    wfile.flush()
                    half = len(args) // 2
                    for part in (args[:half], args[half:]):
                        wfile.write(chunk(cid, model, {"tool_calls": [
                            {"index": 0, "function": {"arguments": part}}]}))
                        wfile.flush()
                        time.sleep(0.2)
                    wfile.write("data: " + json.dumps({
                        "id": cid, "object": "chat.completion.chunk",
                        "created": int(time.time()), "model": model,
                        "choices": [{"index": 0, "delta": {},
                                     "finish_reason": "tool_calls"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5,
                                  "total_tokens": 15}}) + "\n\n")
                    wfile.write("data: [DONE]\n\n")
                else:
                    ok = stream_text(wfile, cid, model,
                                     "Stub reply: a long slow answer. " * 40,
                                     slow=slow_final)
                    if ok:
                        wfile.write("data: " + json.dumps({
                            "id": cid, "object": "chat.completion.chunk",
                            "created": int(time.time()), "model": model,
                            "choices": [{"index": 0, "delta": {},
                                         "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 5, "completion_tokens": 5,
                                      "total_tokens": 10}}) + "\n\n")
                        wfile.write("data: [DONE]\n\n")
                wfile.finish()
            except (BrokenPipeError, ConnectionResetError, OSError) as e:
                log({"ev": "stream_peer_gone", "req": reqno, "err": repr(e)})
            finally:
                self._untrack()
                log({"ev": "request_end", "req": reqno})
            return
        # non-streaming fallback
        if has_tool_result:
            content = "SLEEP_SURVIVED: non-stream final."
        else:
            content = "Stub reply: non-stream."
        self._json(200, {
            "id": cid, "object": "chat.completion", "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8399
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    log({"ev": "stub_start", "port": port})
    srv.serve_forever()


if __name__ == "__main__":
    main()
