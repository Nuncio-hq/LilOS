#!/usr/bin/env python3
"""Spike #22: /api/ws JSON-RPC probe client for hermes serve.

Mirrors the desktop client's behaviour (apps/shared/src/json-rpc-gateway.ts):
- connect ws://127.0.0.1:9119/api/ws?token=...
- after gateway.ready: client.capabilities {server_requests: true}
- heartbeat: `gateway.ping` every 15s; if no inbound frame for 45s -> declare
  heartbeat-dead, drop the socket, reconnect, then replay via
  `session.events.since` + check `session.status`/`session.info`.
- logs EVERYTHING to a JSONL transcript with wall + monotonic clocks; the
  (wall - mono) drift is exactly how a client detects "the machine slept".

Args:
  --label NAME          leg label written into the transcript
  --prompt TEXT         prompt text to submit (default sleep-120 turn)
  --duration SECONDS    how long to keep logging before exiting (default 400)
  --no-prompt           don't create a session / submit a prompt (observe only)
  --session-id SID      attach to an existing live session (reconnect mode)
"""

import argparse
import json
import os
import queue
import sys
import threading
import time

from websockets.sync.client import connect

URL = "ws://127.0.0.1:9119/api/ws?token=spike-token-22"
HB_INTERVAL = 15.0
HB_DEADLINE = 45.0

TRANSCRIPT = os.environ.get("PROBE_TRANSCRIPT", "/Users/devin/spike22/transcript.jsonl")
_tlock = threading.Lock()


def tlog(direction, obj):
    with _tlock:
        with open(TRANSCRIPT, "a") as f:
            f.write(json.dumps({"t_wall": time.time(), "t_mono": time.monotonic(),
                                "dir": direction, "frame": obj}) + "\n")


def marker(mk, **kw):
    tlog("marker", {"label": mk, **kw})


class Conn:
    """One WS connection generation."""

    def __init__(self, outer, sock):
        self.outer = outer
        self.ws = sock
        self.id = 0
        self.pending = {}          # id -> queue for the response
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.alive = True
        self.reader.start()

    def call(self, method, params=None, timeout=30.0):
        self.id += 1
        rid = f"r{self.id}"
        q = queue.Queue()
        self.pending[rid] = q
        self.ws.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                 "method": method, "params": params or {}}))
        tlog("out", {"id": rid, "method": method, "params": params})
        try:
            return q.get(timeout=timeout)
        except queue.Empty:
            return {"timeout": True, "method": method}
        finally:
            self.pending.pop(rid, None)

    def _read_loop(self):
        try:
            for text in self.ws:
                try:
                    frame = json.loads(text)
                except Exception:
                    frame = {"unparsed": text[:400]}
                tlog("in", frame)
                self.outer.note_inbound(frame)
                if isinstance(frame, dict) and frame.get("id") in self.pending:
                    self.pending[frame["id"]].put(frame)
        except Exception as e:
            tlog("in", {"ws_reader_error": repr(e)})
        finally:
            self.alive = False
            self.outer.note_dead("reader_exited")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        self.alive = False


class Probe:
    def __init__(self, label):
        self.label = label
        self.conn: Conn | None = None
        self.last_inbound = time.monotonic()
        self.last_seq = {}          # session_id -> last seq
        self.stop = threading.Event()
        self.turn_done = threading.Event()
        self.message_complete_seen = None

    def note_inbound(self, frame):
        self.last_inbound = time.monotonic()
        p = frame.get("params") if isinstance(frame, dict) else None
        if isinstance(p, dict) and p.get("type") == "gateway.ready":
            self.outer_ready = True
        if isinstance(p, dict) and isinstance(p.get("seq"), int):
            sid = str(p.get("session_id") or self.session_id or "?")
            self.last_seq[sid] = p["seq"]
        if isinstance(p, dict) and p.get("type") == "message.complete":
            self.message_complete_seen = p.get("payload")
            self.turn_done.set()

    def note_dead(self, why):
        tlog("probe", {"ev": "conn_dead", "why": why})

    def connect_once(self, timeout=20.0):
        """Connect; returns True when gateway.ready arrived."""
        tlog("probe", {"ev": "connect_attempt"})
        ws = connect(URL, open_timeout=timeout, close_timeout=3,
                     max_size=50_000_000, ping_interval=None)
        self.conn = Conn(self, ws)
        # wait for gateway.ready (reader thread records it)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.outer_ready:
                return True
            if not self.conn.alive:
                return False
            time.sleep(0.05)
        return False

    outer_ready = False

    def note_ready(self):
        self.outer_ready = True

    def heartbeat_loop(self):
        n = 0
        while not self.stop.is_set():
            time.sleep(HB_INTERVAL)
            if self.stop.is_set():
                return
            idle = time.monotonic() - self.last_inbound
            if idle >= HB_DEADLINE:
                tlog("probe", {"ev": "heartbeat_dead", "idle_s": round(idle, 2),
                               "policy": "deadline 45s -> drop + reconnect"})
                self.reconnect_cycle()
                continue
            c = self.conn
            if c and c.alive:
                n += 1
                try:
                    c.ws.send(json.dumps({"jsonrpc": "2.0", "id": f"hb-{n}",
                                          "method": "gateway.ping", "params": {}}))
                    tlog("out", {"id": f"hb-{n}", "method": "gateway.ping"})
                except Exception as e:
                    tlog("probe", {"ev": "heartbeat_send_failed", "err": repr(e)})
                    self.reconnect_cycle()

    def reconnect_cycle(self):
        """Drop current conn, reconnect with light backoff, then replay."""
        c = self.conn
        if c:
            c.close()
        attempt = 0
        while not self.stop.is_set():
            attempt += 1
            try:
                self.outer_ready = False
                if self.connect_once():
                    tlog("probe", {"ev": "reconnected", "attempt": attempt})
                    break
            except Exception as e:
                tlog("probe", {"ev": "reconnect_failed", "attempt": attempt,
                               "err": repr(e)})
            self.stop.wait(min(2 ** attempt, 10))
        if self.stop.is_set():
            return
        self.after_ready()
        self.resync()

    def after_ready(self):
        if self.conn:
            self.conn.call("client.capabilities", {"server_requests": True})

    def resync(self):
        """Post-reconnect: replay missed events + poll turn state."""
        if not self.session_id or not self.conn:
            return
        last = self.last_seq.get(str(self.session_id), 0)
        r = self.conn.call("session.events.since",
                           {"session_id": self.session_id, "last_seen": last}, timeout=15)
        tlog("probe", {"ev": "replay_result", "since": last,
                       "result_head": json.dumps(r)[:1500]})
        # Reattach to the live session — this is what cancels the
        # ws_orphan_reap countdown for a session whose ws detached.
        try:
            r2 = self.conn.call("session.activate",
                                {"session_id": self.session_id, "omit_messages": True},
                                timeout=15)
            tlog("probe", {"ev": "session.activate", "result_head": json.dumps(r2)[:1500]})
        except Exception as e:
            tlog("probe", {"ev": "session.activate_error", "error": repr(e)})
        try:
            r3 = self.conn.call("session.status", {"session_id": self.session_id}, timeout=15)
            tlog("probe", {"ev": "session.status", "result_head": json.dumps(r3)[:1500]})
        except Exception as e:
            tlog("probe", {"ev": "session.status_error", "error": repr(e)})

    session_id = None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="leg")
    ap.add_argument("--prompt", default="Run `SLEEP:120` now — call the terminal tool to run sleep, then answer.")
    ap.add_argument("--duration", type=float, default=400)
    ap.add_argument("--no-prompt", action="store_true")
    ap.add_argument("--session-id", default=None)
    args = ap.parse_args()

    p = Probe(args.label)
    marker("leg_start", label=args.label, prompt=args.prompt)

    if not p.connect_once():
        marker("fatal", msg="initial connect failed")
        sys.exit(2)
    p.after_ready()
    threading.Thread(target=p.heartbeat_loop, daemon=True).start()

    if args.session_id:
        p.session_id = args.session_id
        p.resync()
    elif not args.no_prompt:
        r = p.conn.call("session.create", {"cols": 220}, timeout=60)
        marker("session_create_result", result=r)
        try:
            p.session_id = r["result"]["session_id"]
        except Exception:
            marker("fatal", msg="no session_id", raw=r)
            sys.exit(3)
        r = p.conn.call("prompt.submit",
                        {"session_id": p.session_id, "text": args.prompt}, timeout=30)
        marker("prompt_submit_result", result=r)

    # observe until duration ends or turn completes + 10s settle
    end = time.monotonic() + args.duration
    while time.monotonic() < end:
        if p.turn_done.wait(timeout=1.0):
            marker("turn_done_wait_10s_settle")
            time.sleep(10)
            break
    marker("leg_end", label=args.label, message_complete=p.message_complete_seen)
    p.stop.set()
    if p.conn:
        p.conn.close()


if __name__ == "__main__":
    main()
