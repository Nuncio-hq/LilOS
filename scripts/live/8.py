#!/usr/bin/env python3
"""Live check for issue #8 — `agents` + `models` over a real `hermes serve`
gateway. Everything below is a real Hermes RPC on ws://127.0.0.1:<port>/api/ws;
nothing is mocked except, in stub mode, the LLM endpoint itself.

Two modes:

  stub (default): a scratch HERMES_HOME gets a `custom_providers` entry,
  `lilos-stub`, pointing at a deterministic in-process OpenAI-compatible
  server (two models). Used on this VM — no real provider is signed in here.

  real: HERMES_PROVIDER/HERMES_MODEL set -> the real HERMES_HOME (or
  $HERMES_HOME) is used untouched and the provider must already be configured
  there (Oscar's Mac: HERMES_PROVIDER=qwen HERMES_MODEL=<model>).

The throwaway profile `lilos-conformance-<rand>` is created via real
`profiles.create` and left on disk — LilOS never deletes engine profiles.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERMES_BIN = os.environ.get("HERMES_BIN") or os.path.expanduser(
    "~/.local/bin/hermes"
)
if not os.path.exists(HERMES_BIN):
    HERMES_BIN = "hermes"

REAL_PROVIDER = (os.environ.get("HERMES_PROVIDER") or "").strip()
REAL_MODEL = (os.environ.get("HERMES_MODEL") or "").strip()

STUB_MODELS = ["stub-model-a", "stub-model-b"]
MARKER = "lilos-conformance-ok"


# ── deterministic OpenAI-compatible stub (stub mode) ──────────────────────────


class _StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep stdout clean
        pass

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models") or self.path.endswith(
            "/v1/models"
        ):
            self._json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": m, "object": "model", "created": 0,
                         "owned_by": "lilos-stub"}
                        for m in STUB_MODELS
                    ],
                },
            )
            return
        self._json(404, {"error": "no such route"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": "no such route"})
            return
        try:
            body = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
            )
        except Exception:
            body = {}
        model = str(body.get("model") or "?")
        # Last user message is the turn's marker: lets the driver key waits to a
        # specific turn instead of counting requests (title-gen calls in between
        # would otherwise miscount).
        msgs = body.get("messages") or []
        text = ""
        for m in reversed(msgs):
            if m.get("role") == "user":
                c = m.get("content")
                text = c if isinstance(c, str) else json.dumps(c)
                break
        self.server.requests.append(  # type: ignore[attr-defined]
            {"model": model, "text": text[:300]})
        self._json(
            200,
            {
                "id": "chatcmpl-stub",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": f"{MARKER}:{model}",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 2,
                    "total_tokens": 5,
                },
            },
        )


def start_stub() -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    srv.requests = []  # type: ignore[attr-defined]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ── minimal websocket client (stdlib only) ────────────────────────────────────


class Ws:
    def __init__(self, url: str):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=15)
        self.sock.settimeout(15)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + ("?" + u.query if u.query else "")
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            resp += chunk
        status = resp.split(b"\r\n", 1)[0].decode("latin1")
        if "101" not in status:
            raise ConnectionError(f"WS upgrade refused: {status.strip()}")
        self.buf = resp.split(b"\r\n\r\n", 1)[1]

    def _read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, payload: str) -> None:
        data = payload.encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        if len(data) < 126:
            header.append(0x80 | len(data))
        elif len(data) < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", len(data))
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", len(data))
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    _last_fin = True

    def _recv_frame(self) -> tuple[int, bytes]:
        b1, b2 = self._read_exact(2)
        self._last_fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        if b2 & 0x80:
            m = self._read_exact(4)
            data = self._read_exact(length)
            data = bytes(c ^ m[i % 4] for i, c in enumerate(data))
        else:
            data = self._read_exact(length)
        return opcode, data

    def recv(self) -> str:
        """Receive one complete message (reassembling fragments, ponging pings)."""
        payload = bytearray()
        while True:
            opcode, data = self._recv_frame()
            if opcode == 0x9:  # ping -> pong
                self._pong(data)
                continue
            if opcode == 0x8:
                raise ConnectionError("ws closed by peer")
            payload += data
            if self._last_fin:
                return payload.decode()

    def _pong(self, data: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x8A])
        header.append(0x80 | len(data))
        header += mask
        self.sock.sendall(
            bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        )

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class Rpc:
    """JSON-RPC over the gateway WS: requests keyed by id, events queued."""

    def __init__(self, ws: Ws):
        self.ws = ws
        self.next_id = 0
        self.events: list[dict] = []

    def request(self, method: str, params: dict, timeout: float = 120.0) -> dict:
        self.next_id += 1
        rid = self.next_id
        self.ws.send(
            json.dumps(
                {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
            )
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "gateway.ping":
                continue
            if "method" in msg and "id" in msg:  # server->client request
                self.ws.send(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": msg["id"],
                            "error": {"code": -32601, "message": "no handlers"},
                        }
                    )
                )
                continue
            if "method" in msg:  # notification
                self.events.append(msg.get("params") or {})
                continue
            if msg.get("id") != rid:
                continue
            if "error" in msg:
                raise RuntimeError(
                    f"{method} -> RPC {msg['error'].get('code')}: "
                    f"{msg['error'].get('message')}"
                )
            res = msg.get("result")
            return res if isinstance(res, dict) else {"result": res}
        raise TimeoutError(f"{method} timed out")


# ── the check ─────────────────────────────────────────────────────────────────

RESULTS: list[tuple[bool, str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((cond, name, detail))
    print(("PASS" if cond else "FAIL") + f"  {name}" + (f" — {detail}" if detail else ""))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main() -> int:
    stub = None
    prof_name = ""
    hermes_home = os.environ.get("HERMES_HOME")
    scratch_home = None
    if REAL_PROVIDER:
        mode = f"real provider {REAL_PROVIDER}/{REAL_MODEL or '(default)'}"
    else:
        stub = start_stub()
        scratch_home = tempfile.mkdtemp(prefix="lilos-issue8-")
        hermes_home = scratch_home
        Path(scratch_home, "config.yaml").write_text(
            "model:\n"
            "  provider: lilos-stub\n"
            "  default: stub-model-a\n"
            "custom_providers:\n"
            "  - name: lilos-stub\n"
            f"    base_url: http://127.0.0.1:{stub.server_address[1]}/v1\n"
            "    api_key: sk-lilos-stub\n"
            "    api_mode: chat_completions\n"
            "    models:\n"
            "      - stub-model-a\n"
            "      - stub-model-b\n",
            encoding="utf-8",
        )
        mode = "STUB provider lilos-stub (deterministic; no real LLM signed in)"
    print(f"# issue #8 live check — engine: hermes serve · mode: {mode}")
    if hermes_home:
        print(f"# HERMES_HOME={hermes_home}")

    token = secrets.token_urlsafe(16)
    port = free_port()
    env = dict(os.environ)
    env["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    if hermes_home:
        env["HERMES_HOME"] = hermes_home
    log_path = Path(tempfile.gettempdir()) / "lilos-issue8-serve.log"
    log_file = log_path.open("w")
    proc = subprocess.Popen(
        [HERMES_BIN, "serve", "--port", str(port), "--host", "127.0.0.1",
         "--skip-build"],
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    ws = rpc = None
    try:
        # wait for the gateway to come up
        # First boot on a fresh HERMES_HOME runs Hermes's update/bootstrap
        # (deps, web UI build, skill sync) — that takes minutes. Poll the WS
        # endpoint for up to 5 minutes; the gateway accepts as soon as uvicorn
        # binds (it logs `HERMES_BACKEND_READY`).
        ws_url = f"ws://127.0.0.1:{port}/api/ws?token={token}"
        deadline = time.time() + 300
        last_err: Exception | None = None
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"hermes serve exited {proc.returncode} — log: {log_path}")
            try:
                ws = Ws(ws_url)
                break
            except OSError as e:
                last_err = e
                time.sleep(2)
        if ws is None:
            raise RuntimeError(
                f"gateway never accepted a ws connection ({last_err}); "
                f"server log: {log_path}")
        # first frame is the gateway.ready notification
        ready = json.loads(ws.recv())
        check("gateway.ready on connect",
              (ready.get("params") or {}).get("type") == "gateway.ready")
        rpc = Rpc(ws)

        cwd = tempfile.mkdtemp(prefix="lilos-issue8-cwd-")
        prof_name = f"lilos-conformance-{secrets.token_hex(3)}"
        provider = REAL_PROVIDER or "lilos-stub"
        model_a = REAL_MODEL or "stub-model-a"
        model_b = STUB_MODELS[1] if not REAL_PROVIDER else REAL_MODEL

        # ── agents.list ↔ profiles.list
        pl = rpc.request("profiles.list", {})
        profiles = pl.get("profiles") or []
        check("profiles.list returns a real profile list",
              isinstance(profiles, list),
              f"{len(profiles)} profile(s) before create")

        # ── agents.create ↔ profiles.create
        cr = rpc.request("profiles.create", {
            "name": prof_name,
            "description": "LilOS issue #8 conformance probe profile",
            "soul": "# lilos-conformance\nCreated by scripts/live/8.sh.",
            "model": model_a,
            "provider": provider,
            "no_alias": True,
        })
        check("profiles.create registers a real profile",
              cr.get("ok") is True and bool(cr.get("path")),
              str(cr.get("path") or cr))

        pl2 = rpc.request("profiles.list", {})
        names = [p.get("name") for p in (pl2.get("profiles") or [])]
        check("profiles.list sees the created profile",
              prof_name in names, f"profiles: {names}")

        # ── agents.describe ↔ profiles.describe (SOUL read-only, model, skills)
        desc = rpc.request("profiles.describe", {"name": prof_name})
        soul = desc.get("soul") or ""
        check("profiles.describe returns persona + model pin",
              "lilos-conformance" in soul
              and isinstance(desc.get("skills"), list),
              f"model={desc.get('model')} skills={len(desc.get('skills') or [])}")

        # ── models.list ↔ model.options
        mo = rpc.request("model.options", {})
        opts = []
        for p in mo.get("providers") or []:
            for m in p.get("models") or []:
                opts.append((p.get("slug") or p.get("name"), m))
        check("model.options lists selectable models",
              len(opts) >= 1,
              f"current={mo.get('provider')}/{mo.get('model')} "
              f"options={opts[:6]}")

        # ── session with a turn on the launch profile (real provider resolution)
        sc = rpc.request("session.create", {
            "cwd": cwd,
            "model": model_a,
            "provider": provider,
        })
        sid = sc.get("session_id") or sc.get("id") or ""
        check("session.create", bool(sid), f"session_id={sid}")

        turn_tag = secrets.token_hex(4)

        def wait_stub_request(text: str, timeout: float = 240) -> str | None:
            """Model of the stub /chat/completions call carrying `text`."""
            assert stub is not None
            end = time.time() + timeout
            while time.time() < end:
                for r in stub.requests:  # type: ignore[attr-defined]
                    if text in r["text"]:
                        return r["model"]
                time.sleep(1)
            return None

        def wait_status(substr: str, timeout: float = 240) -> bool:
            end = time.time() + timeout
            while time.time() < end:
                st = rpc.request("session.status", {"session_id": sid})
                if substr in str(st):
                    return True
                time.sleep(2)
            return False

        def wait_turn_idle(timeout: float = 240) -> None:
            """Real-provider mode: poll session.status until the pane text stops
            growing across polls — the turn has finished rendering."""
            end = time.time() + timeout
            last = -1
            stable = 0
            while time.time() < end and stable < 3:
                st = rpc.request("session.status", {"session_id": sid})
                cur = len(str(st.get("output") or ""))
                stable = stable + 1 if cur == last else 0
                last = cur
                time.sleep(2)

        t1 = f"ping-{turn_tag}-1"
        rpc.request("prompt.submit", {"session_id": sid, "text": t1},
                    timeout=60)
        if stub is not None:
            used = wait_stub_request(t1)
            check("turn 1 runs on the launch model",
                  used == model_a, f"stub saw model={used}")
            wait_status(f"{MARKER}:{model_a}")
        else:
            wait_turn_idle()

        # ── session.setModel ↔ slash.exec /model
        target = f"{provider}/{model_b}" if REAL_PROVIDER else model_b
        sl = rpc.request("slash.exec", {
            "session_id": sid,
            "command": f"/model {target}",
        }, timeout=120)
        out = str(sl.get("output") or "")
        check("slash.exec /model <picked> accepted",
              model_b in out or "switch" in out.lower()
              or "model" in out.lower(),
              out[:240])

        t2 = f"ping-{turn_tag}-2"
        rpc.request("prompt.submit", {"session_id": sid, "text": t2},
                    timeout=60)
        if stub is not None:
            used2 = wait_stub_request(t2)
            check("next turn uses the picked model",
                  used2 == model_b,
                  f"stub saw model={used2} (wanted {model_b})")
            wait_status(f"{MARKER}:{model_b}")
        else:
            wait_turn_idle()

        us = rpc.request("session.usage", {"session_id": sid})
        check("session.usage reports the pinned model",
              model_b in str(us), str(us)[:160])

        with __import__("contextlib").suppress(Exception):
            rpc.request("session.close", {"session_id": sid}, timeout=15)
    except Exception as exc:  # noqa: BLE001 — report, then fail the run
        print(f"FAIL  driver error: {exc}")
        RESULTS.append((False, "driver completed", str(exc)))
    finally:
        if rpc is not None:
            ws.close()
        log_file.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if stub is not None:
            print(f"# stub saw {len(stub.requests)} chat completion(s): "
                  f"{stub.requests}")
            stub.shutdown()

    print("#" * 60)
    failed = [n for ok, n, _ in RESULTS if not ok]
    if failed:
        print(f"RESULT: FAIL — {len(failed)} check(s) failed: {failed}")
        return 1
    print(f"RESULT: PASS — {len(RESULTS)} checks green")
    print(f"# throwaway profile left on disk: {prof_name}")
    print("#   (LilOS never deletes engine profiles — clean up by hand if needed)")
    if scratch_home:
        print(f"# scratch HERMES_HOME kept for inspection: {scratch_home}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
