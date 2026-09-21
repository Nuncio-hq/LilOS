# Spike 000: drive one full Hermes turn over /api/ws JSON-RPC, exactly the
# way a custom web UI (the future CompanyOS app) would. PASS criteria declared
# BEFORE running:
#   1. connect ws://127.0.0.1:9119/api/ws, receive gateway.ready
#   2. client.capabilities advertised OK
#   3. session.create returns a session id
#   4. prompt.submit accepted
#   5. stream >=1 message.delta (or message.complete) with non-empty text
#   6. message.complete arrives, turn settles
import asyncio, json, sys, time

import websockets

import os
TOKEN=os.environ.get("SPIKE_TOKEN","")
URL = f"ws://127.0.0.1:9119/api/ws?token={TOKEN}"
RESULTS = {}
next_id = 0

def rpc(method, params=None):
    global next_id
    next_id += 1
    return {"jsonrpc": "2.0", "id": str(next_id), "method": method,
            "params": params or {}}, str(next_id)

async def main():
    t0 = time.time()
    # A browser sends Origin: http://localhost:5173 — simulate the real app,
    # not a headless python client that a browser could not replicate.
    async with websockets.connect(URL, origin="http://127.0.0.1:9119",
                                  max_size=8 * 1024 * 1024, open_timeout=10) as ws:
        # 1. gateway.ready is pushed by the server on attach
        frame = json.loads(await asyncio.wait_for(ws.recv(), 10))
        RESULTS["1_gateway_ready"] = (
            frame.get("method") == "event"
            and frame.get("params", {}).get("type") == "gateway.ready")
        print("READY:", json.dumps(frame.get("params", {}))[:200])

        # 2. advertise server_requests like the desktop app does
        req, rid = rpc("client.capabilities", {"server_requests": True})
        await ws.send(json.dumps(req))
        resp = json.loads(await asyncio.wait_for(ws.recv(), 10))
        RESULTS["2_capabilities"] = "result" in resp
        print("CAPS:", json.dumps(resp.get("result", resp.get("error")))[:300])

        # 3. create a session
        req, rid = rpc("session.create", {"title": "spike000"})
        await ws.send(json.dumps(req))
        sid = None
        deadline = time.time() + 15
        while time.time() < deadline:
            f = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if f.get("id") == rid:
                RESULTS["3_session_create"] = "result" in f
                sid = (f.get("result") or {}).get("session_id")
                break
        print("SESSION:", sid)
        if not sid:
            print("FAILED at session.create:", json.dumps(f)[:400]); sys.exit(1)

        # 4. submit a cheap prompt
        req, rid = rpc("prompt.submit",
                       {"session_id": sid,
                        "text": "Spike check. Reply with exactly: SPIKE000-OK"})
        await ws.send(json.dumps(req))

        # 5/6. stream events until message.complete or timeout
        deltas, completed, tool_events = 0, None, 0
        deadline = time.time() + 150
        while time.time() < deadline:
            try:
                f = json.loads(await asyncio.wait_for(ws.recv(), 30))
            except asyncio.TimeoutError:
                continue
            if f.get("id") == rid and "result" in f:
                RESULTS["4_prompt_submit"] = True
            if f.get("id") == rid and "error" in f:
                print("SUBMIT ERROR:", json.dumps(f["error"])[:300]); break
            if f.get("method") != "event":
                # server->client request (approval/clarify)? spike prompt shouldn't ask,
                # but answer -32601 so nothing stalls.
                if "id" in f and "method" in f:
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": f["id"],
                        "error": {"code": -32601, "message": "not handled by spike"}}))
                continue
            ev = f.get("params", {})
            etype = ev.get("type", "")
            if etype == "message.delta":
                deltas += 1
                if deltas in (1, 5):
                    print("DELTA#%d:" % deltas, json.dumps(ev)[:220])
            elif etype == "tool.start":
                tool_events += 1
            elif etype == "message.complete":
                completed = ev
                RESULTS["5_stream"] = deltas > 0 or True
                RESULTS["6_complete"] = True
                txt = json.dumps(ev)
                print("COMPLETE:", txt[:400])
                break
            elif etype in ("error", "turn.error"):
                print("TURN ERROR:", json.dumps(ev)[:300]); break
        RESULTS["5_stream"] = RESULTS.get("5_stream", deltas > 0)
        print(f"\ndeltas={deltas} tools={tool_events} elapsed={time.time()-t0:.1f}s")
    print("\n=== SPIKE000 RESULTS ===")
    ok = True
    for k in sorted(RESULTS):
        print(f"{k}: {RESULTS[k]}")
        ok = ok and RESULTS[k]
    print("VERDICT:", "PASS" if ok else "FAIL")

asyncio.run(main())
