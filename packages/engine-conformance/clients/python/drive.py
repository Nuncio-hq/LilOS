#!/usr/bin/env python3
"""AC-3: drive engine-fake over WebSocket using only the generated JSON Schema.

Python standard library only — no pip installs — so it runs anywhere CI does.
Reads packages/contracts/generated/engine-protocol.schema.json, builds request
params from the schema (skeleton + the script's chosen values), and plays a
full session: describe -> session.start -> prompt -> request.opened ->
request.respond -> turn.completed -> events.since -> session.stop.

Usage: drive.py --url ws://127.0.0.1:PORT/ws --schema <engine-protocol.schema.json>
Exits 0 with PASS lines on success, non-zero on any protocol violation.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys


class WebSocket:
    """Minimal RFC 6455 client: text frames only, client frames masked."""

    def __init__(self, url):
        assert url.startswith("ws://"), url
        hostport, _, path = url[5:].partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=20)
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        head = self._until(b"\r\n\r\n")
        assert b" 101" in head.split(b"\r\n", 1)[0], head[:200]
        want = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        )
        assert want in head, "bad Sec-WebSocket-Accept"

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise RuntimeError("socket closed")
        self.buf += chunk

    def _until(self, marker):
        while marker not in self.buf:
            self._fill()
        i = self.buf.index(marker) + len(marker)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def _need(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode()
        head = bytearray([0x81])  # FIN + text opcode
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)  # client frames must be masked
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _send_pong(self, payload):
        mask = os.urandom(4)
        n = len(payload)
        assert n < 126
        self.sock.sendall(
            bytes([0x8A, 0x80 | n]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        )

    def recv(self):
        """Read one complete text message; pings get a pong, close raises."""
        while True:
            b0, b1 = self._need(2)
            fin, op = bool(b0 & 0x80), b0 & 0x0F
            masked, ln = bool(b1 & 0x80), b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._need(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._need(8))[0]
            mask = self._need(4) if masked else None
            payload = self._need(ln) if ln else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if op == 9:
                self._send_pong(payload)
                continue
            if op == 8:
                raise RuntimeError("server closed the socket")
            if not fin or op == 0:
                raise RuntimeError("fragmented frames are unsupported")
            assert op in (1, 2), f"unexpected opcode {op}"
            return json.loads(payload)


class Rpc:
    def __init__(self, url):
        self.ws = WebSocket(url)
        self.next_id = 0
        self.events = []
        self.responded = {}  # requestId -> outcome this client sent

    def send_request(self, method, params):
        self.next_id += 1
        rid = f"py-{self.next_id}"
        self.ws.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return rid

    def _read_until_response(self, rid, on_event=None):
        while True:
            m = self.ws.recv()
            if m.get("method") == "event":
                self.events.append(m["params"])
                if on_event:
                    on_event(m["params"])
                continue
            if m.get("id") == rid:
                if "error" in m:
                    raise ProtocolError(m["error"]["code"], m["error"]["message"])
                return m.get("result")

    def request(self, method, params):
        return self._read_until_response(self.send_request(method, params), self._auto_respond)

    def _auto_respond(self, ev):
        if ev["type"] == "request.opened":
            options = ev["payload"]["request"].get("options", [])
            outcome = "always" if "always" in options else "once"
            self.responded[ev["payload"]["requestId"]] = outcome
            self.send_request(
                "request.respond",
                {
                    "sessionId": ev["sessionId"],
                    "requestId": ev["payload"]["requestId"],
                    "outcome": outcome,
                },
            )


class ProtocolError(Exception):
    def __init__(self, code, message):
        super().__init__(f"RPC {code}: {message}")
        self.code = code


def minimal(schema):
    """Smallest valid value for a JSON Schema fragment (draft 2020-12)."""
    if "$ref" in schema:
        raise NotImplementedError("$ref")
    for combiner in ("anyOf", "oneOf"):
        if combiner in schema:
            return minimal(schema[combiner][0])
    t = schema.get("type")
    if t == "object" or "properties" in schema:
        required = set(schema.get("required", []))
        return {k: minimal(v) for k, v in schema.get("properties", {}).items() if k in required}
    if t == "string":
        return "x"
    if t == "integer":
        return 0
    if t == "number":
        return 0.0
    if t == "boolean":
        return False
    if t == "array":
        n = schema.get("minItems", 0)
        return [minimal(schema["items"]) for _ in range(n)] if n else []
    return None


def check(cond, msg):
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--schema", required=True)
    a = ap.parse_args()

    schema = json.load(open(a.schema))
    methods = schema["methods"]
    rpc = Rpc(a.url)

    r = rpc.request("describe", minimal(methods["describe"]["params"]))
    check(
        r["protocol"] == schema["protocol"],
        f"describe.protocol must equal the schema's declared protocol: {r.get('protocol')}",
    )
    check(isinstance(r.get("capabilities"), list), "describe.capabilities must be a list")
    print(f"PASS describe — engine={r['name']} {r['version']} caps={[c['id'] for c in r['capabilities']]}")

    start_params = minimal(methods["session.start"]["params"])
    start_params.update(
        {
            "agent": "builder",
            "cwd": "/tmp/lilos-python",
            "mcpServers": [{"name": "lilos", "command": "lilos-mcp", "args": [], "env": []}],
        }
    )
    r = rpc.request("session.start", start_params)
    sid = r["sessionId"]
    print(f"PASS session.start — sessionId={sid}")

    prompt_params = minimal(methods["prompt"]["params"])
    prompt_params.update({"sessionId": sid, "content": [{"type": "text", "text": "Fix the README title"}]})
    result = rpc.request("prompt", prompt_params)
    check(result["stopReason"] == "end_turn", f"prompt stopReason {result.get('stopReason')}")
    my_events = [e for e in rpc.events if e["sessionId"] == sid]
    seqs = [e["seq"] for e in my_events]
    check(seqs == sorted(seqs) and seqs[0] == 1, "event seq must be 1-based monotonic per session")
    types = [e["type"] for e in my_events]
    for t in (
        "turn.started",
        "turn.delta",
        "tool.started",
        "tool.completed",
        "request.opened",
        "request.resolved",
        "turn.completed",
    ):
        check(t in types, f"missing event {t}")
    # #133 AC-3 — the engine must echo the outcome the client actually chose:
    # every answered ask resolves to the sent outcome (never a downgrade).
    resolved = {
        e["payload"]["requestId"]: e["payload"].get("outcome")
        for e in my_events
        if e["type"] == "request.resolved"
    }
    for rid, sent in rpc.responded.items():
        check(rid in resolved, f"answered request {rid} must resolve")
        check(
            resolved[rid] == sent,
            f"request.resolved outcome must echo the sent '{sent}', got {resolved[rid]}",
        )
    print(f"PASS prompt+approval — {len(my_events)} events, seq 1..{seqs[-1]}, stopReason={result['stopReason']}")

    r = rpc.request("events.since", {"sessionId": sid, "after": 0})
    check(r["latestSeq"] == seqs[-1], "events.since.latestSeq must equal the last event seq")
    check(len(r["events"]) == len(my_events), "replay after=0 must return the whole log")
    check(r["openRequests"] == [], "openRequests must be empty after the turn")
    check(r["snapshot"]["state"] in ("idle", "closed"), f"snapshot.state={r['snapshot']['state']}")
    print("PASS events.since — replay + snapshot + openRequests")

    try:
        rpc.request("no.such.method", {})
        check(False, "unknown method must error")
    except ProtocolError as e:
        check(e.code == -32601, f"unknown method code must be -32601, got {e.code}")
        print("PASS errors — unknown method -> -32601")

    r = rpc.request("session.stop", {"sessionId": sid})
    check(r["stopped"] is True, "session.stop must return stopped:true")
    print("PASS session.stop")
    print("AC-3 PASS — Python stdlib client drove engine-fake over WebSocket using only the JSON Schema")


if __name__ == "__main__":
    main()
