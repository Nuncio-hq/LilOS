#!/usr/bin/env python3
"""WS probe for spike #23 — drives `hermes serve` over the /api/ws JSON-RPC gateway.

Run with the Hermes-managed python (has `websockets`):
  .../venv/bin/python3 ws_probe.py --port 9119 --token spike-token --home <profile-home>

Scenario (one WS connection):
  W1: session.create -> prompt.submit -> stub LLM calls mcp__lilos__terminal_run
      IF the profile config's mcp_servers carried it in.
  W2: second session.create on the same profile -> prompt.submit -> the stub
      reports whether mcp__lilos__* tools were on the wire for it too
      (NO_LILOS_TOOLS_OFFERED / NO_LILOS_TOOLS... vs a real call).

Answers server->client requests (srq-*) with approval "once"; dumps every
frame to stdout as compact JSON lines.
"""

import argparse
import asyncio
import json
import sys

import websockets

RID = 0


def _rid() -> str:
    global RID
    RID += 1
    return f"c{RID}"


async def rpc(ws, method, params, timeout=120):
    rid = _rid()
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        await _frame(raw)
        msg = json.loads(raw)
        if msg.get("id") == rid:
            if "error" in msg:
                raise RuntimeError(f"{method} failed: {msg['error']}")
            return msg.get("result")


async def _frame(raw):
    """Log a frame; auto-answer server->client requests (srq-* ids)."""
    msg = json.loads(raw)
    mid, meth = msg.get("id"), msg.get("method")
    if isinstance(mid, str) and mid.startswith("srq-"):
        # server->client request (approval/clarify/...): approve once, else -32601
        if meth == "approval":
            result = {"choice": "once"}
        else:
            result = None
        reply = {"jsonrpc": "2.0", "id": mid}
        if result is not None:
            reply["result"] = result
        else:
            reply["error"] = {"code": -32601, "message": f"probe has no handler for {meth}"}
        await CURRENT_WS.send(json.dumps(reply))
        print(f"<<SRQ>> {meth} -> {reply.get('result') or reply['error']['message']}", flush=True)
        return
    if meth == "event":
        p = msg.get("params") or {}
        t = p.get("type")
        if t in ("tool.start", "tool.complete", "message.complete", "error"):
            short = {k: v for k, v in (p.get("payload") or {}).items() if k in (
                "tool_name", "name", "title", "final_text", "error", "message", "tool_call_id", "status")}
            print(f"<<EVT>> {t} {json.dumps(short)[:300]}", flush=True)
        elif t not in ("message.delta", "thinking.delta", "reasoning.delta", "session.usage"):
            print(f"<<EVT>> {t}", flush=True)
    elif mid:
        print(f"<<RSP>> {mid}", flush=True)
    elif meth:
        print(f"<<NTF>> {meth}", flush=True)


CURRENT_WS = None


async def run(port: int, token: str, prompt: str):
    global CURRENT_WS
    url = f"ws://127.0.0.1:{port}/api/ws?token={token}"
    async with websockets.connect(
        url, subprotocols=["hermes-gateway-v1"], max_size=384 * 1024 * 1024, open_timeout=30,
    ) as ws:
        CURRENT_WS = ws
        print(f"[probe] connected {url}", flush=True)
        # first frame should be gateway.ready notification
        raw = await asyncio.wait_for(ws.recv(), 30)
        print(f"<<NTF>> {raw[:300]}", flush=True)
        caps = await rpc(ws, "client.capabilities", {"server_requests": True})
        print(f"[probe] server_requests={caps.get('server_requests')}", flush=True)

        outcomes = {}
        for tag, title in (("W1", "spike23 W1"), ("W2", "spike23 W2")):
            created = await rpc(ws, "session.create", {
                "title": title, "profile": "spike23", "follow_profile_config": True})
            sid = created["session_id"]
            print(f"[probe] {tag} session_id={sid}", flush=True)
            await rpc(ws, "prompt.submit", {"session_id": sid, "text": prompt})
            # wait for the turn's message.complete event
            while True:
                raw = await asyncio.wait_for(ws.recv(), 180)
                await _frame(raw)
                msg = json.loads(raw)
                if (msg.get("method") == "event"
                        and (msg.get("params") or {}).get("type") in ("message.complete", "error")):
                    outcomes[tag] = msg["params"].get("payload") or {}
                    break
        return outcomes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9119)
    ap.add_argument("--token", required=True)
    ap.add_argument("--prompt", default="Run the spike check.")
    args = ap.parse_args()
    out = asyncio.run(run(args.port, args.token, args.prompt))
    print("\n=== WS PROBE RESULT ===")
    print(json.dumps({k: {kk: v[kk] for kk in ("final_text", "status") if kk in v} for k, v in out.items()}, indent=2))


if __name__ == "__main__":
    main()
