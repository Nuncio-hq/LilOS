import { describe, expect, test } from "vitest";
import { FakeEngine, RpcError } from "../src/engine.js";
import { connectFake, handleJsonRpc } from "../src/transport.js";

const conn = (tick = 1) => connectFake(new FakeEngine({ tick }));

async function promptText(
  c: ReturnType<typeof conn>,
  sessionId: string,
  text: string,
) {
  return c.request("prompt", {
    sessionId,
    content: [{ type: "text", text }],
  }) as Promise<{
    turnId: string;
    stopReason: string;
  }>;
}

describe("engine-fake", () => {
  test("is deterministic: same input, same event stream", async () => {
    const collect = async () => {
      const c = conn();
      const log: string[] = [];
      c.onEvent((e) => log.push(JSON.stringify(e)));
      const { sessionId } = (await c.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as {
        sessionId: string;
      };
      await promptText(c, sessionId, "Explain the relay package");
      c.close();
      return log;
    };
    const a = await collect();
    const b = await collect();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  test("describe advertises lilos-engine protocol + capabilities", async () => {
    const c = conn();
    const r = (await c.request("describe")) as {
      protocol: { name: string; version: number };
      capabilities: { id: string }[];
    };
    expect(r.protocol).toEqual({ name: "lilos-engine", version: 1 });
    expect(r.capabilities.map((x) => x.id)).toEqual([
      "steer",
      "mcp_servers",
      "agents",
      "models",
    ]);
    c.close();
  });

  test("rejects unknown methods, bad params, closed sessions", async () => {
    const c = conn();
    await expect(c.request("bogus.method")).rejects.toMatchObject({
      code: -32601,
    });
    await expect(
      c.request("session.start", { agent: "x" }),
    ).rejects.toMatchObject({ code: -32602 });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    await expect(
      c.request("request.respond", {
        sessionId,
        requestId: "nope",
        outcome: "once",
      }),
    ).rejects.toMatchObject({
      code: -32002,
    });
    await c.request("session.stop", { sessionId });
    await expect(promptText(c, sessionId, "look")).rejects.toMatchObject({
      code: -32003,
    });
    c.close();
  });

  test("prompt rejects image blocks (no image_prompt capability)", async () => {
    const c = conn();
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    await expect(
      c.request("prompt", {
        sessionId,
        content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    c.close();
  });

  test("interrupt during an approval cancels the ask and the turn", async () => {
    const c = conn();
    const seen: string[] = [];
    c.onEvent((e) => seen.push(e.type));
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    const p = promptText(c, sessionId, "Fix the README title");
    await new Promise((r) => {
      const check = () =>
        seen.includes("request.opened") ? r(null) : setTimeout(check, 1);
      check();
    });
    const ack = (await c.request("interrupt", { sessionId })) as {
      interrupted: boolean;
    };
    expect(ack.interrupted).toBe(true);
    const res = await p;
    expect(res.stopReason).toBe("cancelled");
    expect(seen).toContain("request.resolved");
    const since = (await c.request("events.since", {
      sessionId,
      after: 0,
    })) as { openRequests: unknown[] };
    expect(since.openRequests).toEqual([]);
    c.close();
  });

  test("handleJsonRpc: parse error, notification silence, batch rejection", async () => {
    const engine = new FakeEngine({ tick: 1 });
    expect(await handleJsonRpc(engine, "{nope")).toContain('"code":-32700');
    expect(
      await handleJsonRpc(engine, '{"jsonrpc":"2.0","method":"describe"}'),
    ).toBeNull(); // notification: no reply
    expect(await handleJsonRpc(engine, "[]")).toContain('"code":-32600');
    const ok = await handleJsonRpc(
      engine,
      '{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}',
    );
    expect(JSON.parse(ok as string).result.protocol.version).toBe(1);
  });

  test("RpcError carries code and message", () => {
    const e = new RpcError(-32001, "nope", { sessionId: "x" });
    expect(e.code).toBe(-32001);
    expect(e.data).toEqual({ sessionId: "x" });
  });
});
