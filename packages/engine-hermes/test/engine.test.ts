import { Harness } from "@lilos/engine-conformance";
import { describe, expect, test } from "vitest";
import { HermesEngine } from "../src/engine.js";
import type { EngineEvent } from "@lilos/contracts/engine";
import { connectInMemory } from "../src/transport.js";
import { FakeGateway } from "./fake-gateway.js";

/**
 * engine-hermes over a scripted in-process gateway — same wire shapes as the
 * live `hermes serve` (see fake-gateway.ts). The live run against real Hermes
 * is `bun run live:hermes` (scripts/live-hermes.ts); this suite is the
 * deterministic half.
 */

function setup() {
  const gw = new FakeGateway();
  const engine = new HermesEngine({ gateway: gw });
  const conn = connectInMemory(engine);
  return { gw, engine, conn, h: new Harness(conn) };
}

async function start(h: Harness, params: Record<string, unknown> = {}) {
  return (await h.request("session.start", {
    agent: "builder",
    cwd: "/tmp/lilos-hermes",
    ...params,
  })) as { sessionId: string };
}

function promptAsync(h: Harness, sessionId: string, text = "hi") {
  return h.request("prompt", {
    sessionId,
    content: [{ type: "text", text }],
  }) as Promise<{ turnId: string; stopReason: string }>;
}

const ev = (e: EngineEvent, t: string, extra?: Record<string, unknown>) => {
  const p = e.payload as Record<string, unknown>;
  return e.type === t && Object.entries(extra ?? {}).every(([k, v]) => p[k] === v);
};

describe("engine-hermes AC-1: live turn maps hermes events", () => {
  test("AC-1 stream + tool + usage -> end_turn", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    expect(ev(h.events[0], "session.started")).toBe(true);

    const p = promptAsync(h, sessionId, "Explain the relay package");
    gw.emit(gw.lastSid, "reasoning.delta", { text: "let me think" });
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_1",
      name: "terminal",
      args: { cmd: "ls" },
    });
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_1",
      name: "terminal",
      result: { ok: true },
      result_text: "files",
      duration_s: 0.2,
    });
    gw.emit(gw.lastSid, "message.delta", { text: "here is" });
    gw.complete(gw.lastSid);

    const res = await p;
    expect(res.stopReason).toBe("end_turn");
    const types = h.events.map((e) => e.type);
    expect(types).toContain("turn.delta");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    const done = h.events.find((e) => e.type === "turn.completed");
    expect((done?.payload as { usage?: { input: number } }).usage?.input).toBe(10);
    // seq monotonic from 1
    h.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });
});

describe("engine-hermes AC-2: approvals & clarifies", () => {
  test("AC-2a approval srq -> request.opened -> respond once", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    const ask = gw.ask(gw.lastSid, "approval", {
      request_id: "r1",
      command: "rm -rf x",
      description: "remove dir",
      choices: ["once", "session", "always", "deny"],
      allow_permanent: true,
      allow_session: true,
      tool_name: "terminal",
    });
    const opened = await h.waitEvent((e) => e.type === "request.opened");
    const req = (opened.payload as { request: { kind: string; options?: string[] } }).request;
    expect(req.kind).toBe("approval");
    // `session` has no protocol equivalent -> dropped
    expect(req.options).toEqual(["once", "always", "deny"]);
    const requestId = (opened.payload as { requestId: string }).requestId;

    const snap = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { snapshot: { state: string }; openRequests: { requestId: string }[] };
    expect(snap.snapshot.state).toBe("waiting");
    expect(snap.openRequests.map((r) => r.requestId)).toContain(requestId);

    await h.request("request.respond", {
      sessionId,
      requestId,
      outcome: "once",
    });
    const res = await ask;
    expect(res.result).toEqual({ choice: "once" });
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-2b clarify batch -> one request.opened per qid, answers merged", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    const ask = gw.ask(gw.lastSid, "clarify", {
      questions: [
        { qid: "a", question: "pick A", choices: ["x", "y"] },
        { qid: "b", question: "free text B" },
      ],
    });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const o = await h.waitEvent(
        (e) =>
          e.type === "request.opened" &&
          !ids.includes((e.payload as { requestId: string }).requestId),
      );
      ids.push((o.payload as { requestId: string }).requestId);
    }
    await h.request("request.respond", {
      sessionId,
      requestId: ids[0],
      outcome: "answer",
      answer: "x",
    });
    await h.request("request.respond", {
      sessionId,
      requestId: ids[1],
      outcome: "answer",
      answer: "text B",
    });
    const res = await ask;
    expect(res.result).toEqual({ answers: { a: "x", b: "text B" } });
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-2c clarify single -> {answer}; cancel -> {} (cancel-all)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p1 = promptAsync(h, sessionId);
    const ask = gw.ask(gw.lastSid, "clarify", { question: "which file?" });
    const opened = await h.waitEvent((e) => e.type === "request.opened");
    await h.request("request.respond", {
      sessionId,
      requestId: (opened.payload as { requestId: string }).requestId,
      outcome: "answer",
      answer: "src/main.ts",
    });
    expect((await ask).result).toEqual({ answer: "src/main.ts" });
    gw.complete(gw.lastSid);
    await p1;

    const p2 = promptAsync(h, sessionId);
    const ask2 = gw.ask(gw.lastSid, "clarify", { question: "again?" });
    const opened2 = await h.waitEvent(
      (e) =>
        e.type === "request.opened" &&
        (e.payload as { requestId: string }).requestId !==
          (opened.payload as { requestId: string }).requestId,
    );
    await h.request("request.respond", {
      sessionId,
      requestId: (opened2.payload as { requestId: string }).requestId,
      outcome: "cancel",
    });
    expect((await ask2).result).toEqual({});
    gw.complete(gw.lastSid);
    await p2;
  });

  test("AC-2d desktop bridges (sudo/secret/vault/preview) refused -32601", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    for (const method of [
      "sudo",
      "secret",
      "vault.unlock_prompt",
      "vault.save_login",
      "preview.act",
      "terminal.read",
    ]) {
      const res = await gw.ask(gw.lastSid, method, {});
      expect(res.error?.code).toBe(-32601);
    }
    expect(h.events.some((e) => e.type === "request.opened")).toBe(false);
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-2e server request.cancel resolves request.resolved cancel", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    const ask = gw.ask(gw.lastSid, "approval", {
      command: "x",
      choices: ["once", "deny"],
    });
    const opened = await h.waitEvent((e) => e.type === "request.opened");
    const wireId = (opened.payload as { requestId: string }).requestId;
    gw.cancelRequest(wireId, "approval", "superseded");
    const resolved = await h.waitEvent(
      (e) => e.type === "request.resolved",
    );
    expect((resolved.payload as { outcome: string }).outcome).toBe("cancel");
    ask.catch(() => {}); // srq left unanswered by design
    gw.complete(gw.lastSid);
    await p;
  });
});

describe("engine-hermes AC-3: ref rotation on compression", () => {
  test("AC-3a session.info stored_session_id -> session.ref.changed", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const oldRef = gw.lastRef;
    gw.emit(gw.lastSid, "session.info", { stored_session_id: "ref-new" });
    const e = await h.waitEvent((x) => x.type === "session.ref.changed");
    const p = e.payload as { ref: string; previousRef: string };
    expect(p.ref).toBe("ref-new");
    expect(p.previousRef).toBe(oldRef);
  });

  test("AC-3b silent rotation caught by session.title poll post-turn", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const oldRef = gw.lastRef;
    const p = promptAsync(h, sessionId);
    gw.rotateRef(gw.lastSid, "ref-rotated"); // no event — compression re-keys quietly
    gw.complete(gw.lastSid);
    await p;
    const e = h.events.find((x) => x.type === "session.ref.changed");
    expect(e).toBeTruthy();
    expect((e?.payload as { ref: string }).ref).toBe("ref-rotated");
    expect((e?.payload as { previousRef: string }).previousRef).toBe(oldRef);
  });
});

describe("engine-hermes AC-4: interrupt & steer", () => {
  test("AC-4a interrupt mid-turn -> cancelled turn", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    await h.waitEvent((e) => e.type === "turn.started");
    const r = (await h.request("interrupt", { sessionId })) as {
      interrupted: boolean;
    };
    expect(r.interrupted).toBe(true);
    gw.complete(gw.lastSid, { status: "interrupted" });
    const res = await p;
    expect(res.stopReason).toBe("cancelled");
  });

  test("AC-4b idle interrupt -> interrupted:false", async () => {
    const { h } = setup();
    const { sessionId } = await start(h);
    const r = (await h.request("interrupt", { sessionId })) as {
      interrupted: boolean;
    };
    expect(r.interrupted).toBe(false);
  });

  test("AC-4c mid-turn steer -> queued lands as turn.steered", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    await h.waitEvent((e) => e.type === "turn.started");
    const r = (await h.request("session.steer", {
      sessionId,
      text: "use bun instead",
    })) as { status: string };
    expect(r.status).toBe("steered");
    expect(gw.steers).toContain("use bun instead");
    const steered = await h.waitEvent((e) => e.type === "turn.steered");
    expect((steered.payload as { text: string }).text).toBe("use bun instead");
    gw.complete(gw.lastSid);
    await p;
  });
});

describe("engine-hermes AC-5: images & state & errors", () => {
  test("AC-5a image blocks attach via image.attach_bytes before submit", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = h.request("prompt", {
      sessionId,
      content: [
        { type: "text", text: "what is this" },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(gw.attachedImages.length).toBe(1);
    expect(gw.attachedImages[0].content_base64).toBe("aW1n");
    expect(gw.lastPrompt?.text).toBe("what is this");
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-5b mcpServers without acp transport -> -32602", async () => {
    const { h } = setup();
    await expect(
      h.request("session.start", {
        agent: "a",
        cwd: "/tmp/x",
        mcpServers: [
          { name: "fs", command: "mcp-fs", args: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("AC-5c closed session: prompt -> -32003, prompt on missing -> -32001", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.complete(gw.lastSid);
    await p;
    await h.request("session.stop", { sessionId });
    await expect(
      h.request("prompt", {
        sessionId,
        content: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: -32003 });
    await expect(
      h.request("prompt", {
        sessionId: "nope",
        content: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: -32001 });
  });

  test("AC-5d request.respond on unknown request -> -32002", async () => {
    const { h } = setup();
    const { sessionId } = await start(h);
    await expect(
      h.request("request.respond", {
        sessionId,
        requestId: "zzz",
        outcome: "once",
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});
