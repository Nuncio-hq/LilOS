import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@lilos/contracts/engine";
import { Harness } from "@lilos/engine-conformance";
import { describe, expect, test } from "vitest";
import { HermesEngine } from "../src/engine.js";
import { RpcError } from "../src/errors.js";
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
  return (
    e.type === t && Object.entries(extra ?? {}).every(([k, v]) => p[k] === v)
  );
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
    if (!done) throw new Error("turn.completed missing");
    const usage = (done.payload as { usage?: { input: number } }).usage;
    expect(usage?.input).toBe(10);
    // seq monotonic from 1
    h.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
    });
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
    const req = (
      opened.payload as { request: { kind: string; options?: string[] } }
    ).request;
    expect(req.kind).toBe("approval");
    // `session` has no protocol equivalent -> dropped
    expect(req.options).toEqual(["once", "always", "deny"]);
    const requestId = (opened.payload as { requestId: string }).requestId;

    const snap = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as {
      snapshot: { state: string };
      openRequests: { requestId: string }[];
    };
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
    const resolved = await h.waitEvent((e) => e.type === "request.resolved");
    expect((resolved.payload as { outcome: string }).outcome).toBe("cancel");
    ask.catch(() => {}); // srq left unanswered by design
    gw.complete(gw.lastSid);
    await p;
  });
});

describe("engine-hermes AC-3: ref rotation on compression", () => {
  test("AC-3a session.info stored_session_id -> session.ref.changed", async () => {
    const { gw, h } = setup();
    await start(h);
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
    const p2 = e?.payload as { ref: string; previousRef: string };
    expect(p2.ref).toBe("ref-rotated");
    expect(p2.previousRef).toBe(oldRef);
  });
});

describe("engine-hermes #137: auto titles map to session.titled", () => {
  test("AC-1 session.title event -> session.titled (derived then llm)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    // tui_gateway/prompt_turn.py:_on_session_title — Hermes fires
    // `session.title` for the persisted auto title only, first with the
    // instant "derived" title, then the model-written upgrade.
    gw.emit(gw.lastSid, "session.title", {
      title: "Explain the relay package",
    });
    const derived = await h.waitEvent(
      h.forSession(sessionId, (e) => e.type === "session.titled"),
    );
    expect(derived.payload).toEqual({
      title: "Explain the relay package",
      source: "derived",
    });
    gw.emit(gw.lastSid, "session.title", {
      title: "Explain the Relay Package",
    });
    const llm = await h.waitEvent(
      h.forSession(
        sessionId,
        (e) =>
          e.type === "session.titled" &&
          (e.payload as { source: string }).source === "llm",
      ),
    );
    expect(llm.payload).toEqual({
      title: "Explain the Relay Package",
      source: "llm",
    });

    // The settled title rides the replay snapshot too (events.since).
    const snap = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { snapshot: { title?: string } };
    expect(snap.snapshot.title).toBe("Explain the Relay Package");
  });

  test("AC-1 session.info title change -> session.titled llm", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    // tui_gateway/server.py:_session_info — a `session.title` set call emits
    // session.info, and any engine-side rename (CLI `hermes title`) also
    // surfaces there; the first title seen is the instant one.
    gw.emit(gw.lastSid, "session.info", { title: "Deploy notes" });
    const e = await h.waitEvent(
      h.forSession(sessionId, (x) => x.type === "session.titled"),
    );
    expect(e.payload).toEqual({ title: "Deploy notes", source: "derived" });
    gw.emit(gw.lastSid, "session.info", { title: "Deploy notes v2" });
    const e2 = await h.waitEvent(
      h.forSession(
        sessionId,
        (x) =>
          x.type === "session.titled" &&
          (x.payload as { title: string }).title === "Deploy notes v2",
      ),
    );
    expect((e2.payload as { source: string }).source).toBe("llm");
  });

  test("AC-2 our own session.setTitle does not bounce back as session.titled", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    // The app-side rename (#28) answers session.title then Hermes echoes it
    // in session.info — the engine must not re-report it as an engine title.
    await h.request("session.setTitle", {
      sessionId,
      title: "Named by Oscar",
    });
    gw.emit(gw.lastSid, "session.info", { title: "Named by Oscar" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.events.filter((e) => e.type === "session.titled")).toHaveLength(0);
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
        agent: "builder",
        cwd: "/tmp/x",
        mcpServers: [{ name: "fs", command: "mcp-fs", args: [] }],
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

describe("engine-hermes #50: tolerate older Hermes gateways", () => {
  test("AC-1 session.create retries without a refused optional field, once per gateway", async () => {
    const gw = new FakeGateway();
    gw.forbiddenCreateFields = new Set(["cwd_explicit"]); // Oscar's 2026.9.24 build
    const engine = new HermesEngine({ gateway: gw });
    const h = new Harness(connectInMemory(engine));

    const { sessionId } = await start(h);
    expect(sessionId).toBeTruthy();
    expect(gw.createRejects).toBe(1); // one extra_forbidden, then retried without it
    expect(gw.createCalls).toHaveLength(2);
    expect(gw.createCalls[0].cwd_explicit).toBe(true);
    expect(gw.createCalls[1]).not.toHaveProperty("cwd_explicit");

    // The drop is remembered for the life of the gateway connection.
    await start(h);
    expect(gw.createRejects).toBe(1);
    expect(gw.createCalls).toHaveLength(3);
    expect(gw.createCalls[2]).not.toHaveProperty("cwd_explicit");

    // And every droppable field is negotiated independently.
    gw.forbiddenCreateFields = new Set(["source", "close_on_disconnect"]);
    await start(h);
    const last = gw.createCalls.at(-1) ?? {};
    expect(last).not.toHaveProperty("source");
    expect(last).not.toHaveProperty("close_on_disconnect");
    expect(last.cwd_explicit).toBeUndefined(); // still remembered
    expect(last.profile).toBe("builder");
    expect(last.cwd).toBe("/tmp/lilos-hermes");
  });

  test("AC-1 a field outside the droppable set fails closed (profile is never stripped)", async () => {
    const gw = new FakeGateway();
    gw.forbiddenCreateFields = new Set(["profile"]);
    const engine = new HermesEngine({ gateway: gw });
    const h = new Harness(connectInMemory(engine));
    await expect(start(h)).rejects.toMatchObject({ code: 4000 });
    // One attempt, full params — nothing silently stripped.
    expect(gw.createCalls).toHaveLength(1);
    expect(gw.createCalls[0].profile).toBe("builder");
  });

  test("AC-3 session.setModel validates against model.options before config.set", async () => {
    const gw = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw });
    const h = new Harness(connectInMemory(engine));
    const { sessionId } = await start(h);

    await expect(
      h.request("session.setModel", { sessionId, model: "no-such-model" }),
    ).rejects.toMatchObject({ code: -32005 });
    expect(gw.configSetCalls.filter((c) => c.key === "model")).toHaveLength(0); // refused before config.set ran

    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "stub-model-b",
      provider: "stub",
    })) as { model: string; provider?: string };
    expect(ack.model).toBe("stub-model-b");
    expect(ack.provider).toBe("stub");
    expect(gw.configSetCalls.map((c) => `${c.key}=${c.value}`)).toEqual([
      "model=stub-model-b --provider stub --session",
    ]);
  });

  test("AC-4 describe() states the minimum Hermes version; create captures the gateway build", async () => {
    const gw = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw });
    const h = new Harness(connectInMemory(engine));
    const d = (await h.request("describe")) as {
      capabilities: { id: string; detail?: Record<string, unknown> }[];
    };
    const cap = d.capabilities.find((c) => c.id === "hermes_gateway");
    expect(typeof cap?.detail?.minVersion).toBe("string");
    expect(String(cap?.detail?.minVersion)).toMatch(/\d/);

    await start(h);
    const d2 = (await h.request("describe")) as typeof d;
    const cap2 = d2.capabilities.find((c) => c.id === "hermes_gateway");
    expect(cap2?.detail?.gatewayVersion).toBe("v0.21.5+test");
    expect(cap2?.detail?.releaseDate).toBe("2026.9.24");
  });
});

describe("engine-hermes #8: agents + models capabilities", () => {
  test("describe declares agents + models with their methods", async () => {
    const { h } = setup();
    const d = (await h.request("describe")) as {
      capabilities: {
        id: string;
        methods?: string[];
        detail?: Record<string, unknown>;
      }[];
    };
    const agents = d.capabilities.find((c) => c.id === "agents");
    const models = d.capabilities.find((c) => c.id === "models");
    expect(agents?.methods).toEqual([
      "agents.list",
      "agents.describe",
      "agents.create",
      "agents.update",
    ]);
    expect(agents?.detail?.updatable).toEqual(["description", "soul", "model"]);
    expect(models?.methods).toEqual(["models.list", "session.setModel"]);
  });

  test("agents.* map to profiles.*; unknown ids -> -32004", async () => {
    const { gw, h } = setup();
    const { agents } = (await h.request("agents.list")) as {
      agents: { id: string; name: string; skillCount?: number }[];
    };
    expect(agents.map((a) => a.id)).toContain("builder");
    expect(agents[0].skillCount).toBe(3);

    const d = (await h.request("agents.describe", { id: "builder" })) as {
      agent: { id: string; soul?: string };
    };
    expect(d.agent.soul).toBe("You are Builder.");
    await expect(
      h.request("agents.describe", { id: "ghost" }),
    ).rejects.toMatchObject({ code: -32004 });
    await expect(
      h.request("session.start", { agent: "ghost", cwd: "/tmp/x" }),
    ).rejects.toMatchObject({ code: -32004 });

    const created = (await h.request("agents.create", {
      name: "reviewer",
      soul: "You review.",
      model: "stub-model-b",
      provider: "stub",
    })) as { agent: { id: string; model?: string } };
    expect(created.agent.id).toBe("reviewer");
    expect(created.agent.model).toBe("stub-model-b");
    // AC-8 hire leg: `{provider, id}` — never a joined `provider/model` ref.
    expect(gw.profiles.get("reviewer")?.soul).toBe("You review.");
    expect(gw.profiles.get("reviewer")?.provider).toBe("stub");
    await expect(
      h.request("agents.create", { name: "reviewer" }),
    ).rejects.toMatchObject({ code: -32003 });
  });

  test("agents.update maps to profiles.configure; guarded model asks for confirm", async () => {
    const { gw, h } = setup();
    const r = (await h.request("agents.update", {
      id: "builder",
      soul: "You are Builder v2.",
      description: "updated",
      model: "stub-model-b",
    })) as { agent: { soul?: string; description?: string; model?: string } };
    expect(r.agent.soul).toBe("You are Builder v2.");
    expect(r.agent.description).toBe("updated");
    expect(r.agent.model).toBe("stub-model-b");
    const pr = gw.profiles.get("builder");
    expect(pr?.soul).toBe("You are Builder v2.");
    expect(pr?.model).toBe("stub-model-b");

    // Rename is CLI-only in Hermes — the wire refuses it.
    await expect(
      h.request("agents.update", { id: "builder", name: "boss" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      h.request("agents.update", { id: "ghost", soul: "x" }),
    ).rejects.toMatchObject({ code: -32004 });

    // Guarded models surface the engine's confirm message; a confirm:true
    // re-send pins them.
    gw.guardedModels.add("stub-model-a");
    const ask = (await h.request("agents.update", {
      id: "builder",
      model: "stub-model-a",
    })) as { agent: { model?: string }; confirmModel?: string };
    expect(ask.confirmModel).toContain("stub-model-a");
    expect(ask.agent.model).toBe("stub-model-b"); // not applied yet
    const done = (await h.request("agents.update", {
      id: "builder",
      model: "stub-model-a",
      confirmModel: true,
    })) as { agent: { model?: string } };
    expect(done.agent.model).toBe("stub-model-a");
    expect(gw.profiles.get("builder")?.model).toBe("stub-model-a");
  });

  test("AC-1 models.list returns every authenticated provider's models, grouped by provider", async () => {
    const { h } = setup();
    const r = (await h.request("models.list")) as {
      models: { id: string; provider?: string }[];
      providers?: { id: string }[];
      default?: string;
    };
    expect(r.models.map((m) => m.id)).toEqual([
      "stub-model-a",
      "stub-model-b",
      "devin/claude-opus-5",
    ]);
    expect(r.models[0].provider).toBe("stub");
    // The devin-provider row is listed even though the ambient provider is stub.
    expect(r.models[2].provider).toBe("devin");
    // The unauthenticated "ghost" row never reaches the picker.
    expect(r.models.map((m) => m.id)).not.toContain("ghost-model");
    expect(r.providers?.map((p) => p.id)).toEqual(["stub", "devin"]);
    expect(r.default).toBe("stub-model-a");
  });

  test("AC-2 capabilities map to per-model efforts / fast flags", async () => {
    const { h } = setup();
    const r = (await h.request("models.list")) as {
      models: { id: string; efforts?: string[]; fast?: boolean }[];
    };
    const a = r.models.find((m) => m.id === "stub-model-a");
    const b = r.models.find((m) => m.id === "stub-model-b");
    const opus = r.models.find((m) => m.id === "devin/claude-opus-5");
    // reasoning:true without a reported list → the full ladder.
    expect(a?.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(a?.fast).toBe(true);
    // No reasoning → no slider; no fast tier → no ⚡Fast.
    expect(b?.efforts).toBeUndefined();
    expect(b?.fast).toBeUndefined();
    // can_disable_reasoning:false → "none" drops off the stops.
    expect(opus?.efforts).not.toContain("none");
    expect(opus?.efforts?.[0]).toBe("minimal");
    expect(opus?.fast).toBe(true);
  });

  test("AC-4 (#194) models.list derives names from bare ids — the real Hermes catalog shapes", async () => {
    const { gw, h } = setup();
    /* A catalog like Oscar's live `model.options`: several providers × many
       models — date-pinned Anthropic ids, `[1m]` routes, `-fast` variants,
       `-900k` context ids, aggregator ids with `/` inside (never split or
       rejoined for identity, #92 AC-8). */
    gw.modelProviders = [
      {
        slug: "hpc",
        name: "HPC",
        models: ["qwen3.8-flash-next", "qwen3-32b"],
      },
      {
        slug: "anthropic-cliproxy",
        name: "Anthropic – CLIProxyAPI",
        models: [
          "claude-opus-4-5-20251101",
          "claude-sonnet-5[1m]",
          "claude-opus-4.8",
          "claude-opus-4.8-fast",
        ],
      },
      {
        slug: "openai-codex",
        name: "ChatGPT or Codex Subscription",
        models: ["gpt-6-sol-900k", "gpt-5.5-preview"],
      },
      {
        slug: "agentauth",
        name: "AgentAuth (Devin Cascade)",
        models: ["devin/claude-opus-5", "devin/kimi-k3"],
      },
      {
        slug: "xai-oauth",
        name: "xAI Grok OAuth",
        models: ["grok-4.6", "grok-4.20-0309-non-reasoning"],
      },
    ];
    const r = (await h.request("models.list")) as {
      models: { id: string; name?: string; provider?: string }[];
    };
    expect(r.models.map((m) => [m.id, m.name])).toEqual([
      ["qwen3.8-flash-next", "Qwen3.8 Flash Next"],
      ["qwen3-32b", "Qwen3 32B"],
      ["claude-opus-4-5-20251101", "Opus 4.5"],
      ["claude-sonnet-5[1m]", "Sonnet 5 1M"],
      ["claude-opus-4.8", "Opus 4.8"],
      ["claude-opus-4.8-fast", "Opus 4.8 Fast"],
      ["gpt-6-sol-900k", "GPT-6-sol-900k"],
      ["gpt-5.5-preview", "GPT-5.5 Preview"],
      ["devin/claude-opus-5", "Opus 5"],
      ["devin/kimi-k3", "Kimi K3"],
      ["grok-4.6", "Grok 4.6"],
      ["grok-4.20-0309-non-reasoning", "Grok 4.20 0309 Non Reasoning"],
    ]);
    // Ids come back verbatim — `devin/…` keeps its slash; the name is display
    // only and never feeds identity (#92 AC-8).
    expect(r.models.map((m) => m.id)).toContain("devin/claude-opus-5");
    // Look-alike ids never collapse to one label.
    const names = r.models.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("AC-6 models.list passes refresh through; a new provider's model appears", async () => {
    const { gw, h } = setup();
    gw.refreshProviders.push({
      slug: "anthropic",
      name: "Anthropic",
      models: ["claude-opus-4.8"],
    });
    const r = (await h.request("models.list", { refresh: true })) as {
      models: { id: string; provider?: string }[];
    };
    expect(gw.modelOptionsCalls.at(-1)?.refresh).toBe(true);
    expect(r.models.map((m) => m.id)).toContain("claude-opus-4.8");
  });

  test("session.setModel picks effort + fast; the next turn.started carries them", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    /* A model with a fast tier + an effort ladder: claude-opus-5 reports
       both, so the whole pick lands. */
    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "devin/claude-opus-5",
      effort: "xhigh",
      fast: true,
    })) as { model: string; effort?: string; fast?: boolean };
    expect(ack.model).toBe("devin/claude-opus-5");
    expect(ack.effort).toBe("xhigh");
    expect(ack.fast).toBe(true);
    /* `config.set model` always carries `--session` — a bare switch would
       persist to config.yaml and retarget every employee's default (#92). */
    expect(gw.configSetCalls.map((c) => `${c.key}=${c.value}`)).toEqual([
      "model=devin/claude-opus-5 --reasoning xhigh --session",
      "fast=on",
    ]);
    expect(gw.sessionModels.get(gw.lastSid)).toBe("devin/claude-opus-5");
    expect(gw.sessionEfforts.get(gw.lastSid)).toBe("xhigh");
    expect(gw.sessionFast.get(gw.lastSid)).toBe(true);

    const p = promptAsync(h, sessionId);
    const started = h.events.find((e) => e.type === "turn.started");
    if (!started) throw new Error("turn.started missing");
    const pl = started.payload as {
      model?: string;
      effort?: string;
      fast?: boolean;
    };
    expect(pl.model).toBe("devin/claude-opus-5");
    expect(pl.effort).toBe("xhigh");
    expect(pl.fast).toBe(true);
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-4 a pick while running defers the model leg (never errors); confirm_required is answered", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    gw.runningSids.add(gw.lastSid);
    gw.confirmModels.add("stub-model-a");

    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "stub-model-a",
      provider: "stub",
    })) as { model: string; deferred?: boolean };
    expect(ack.model).toBe("stub-model-a");
    expect(ack.deferred).toBe(true);
    // First call refused pending confirm → retried once with the flag.
    const calls = gw.configSetCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0].confirm_expensive_model).toBe(false);
    expect(calls[1].confirm_expensive_model).toBe(true);
    expect(calls[1].value).toBe("stub-model-a --provider stub --session");
  });

  test("AC-4 a mid-turn pick sends fast live; the deferred model applies at the next prompt — no driver replay", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p1 = promptAsync(h, sessionId);
    await h.waitEvent((e) => e.type === "turn.started");

    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "devin/claude-opus-5",
      provider: "devin",
      effort: "high",
      fast: true,
    })) as { model: string; deferred?: boolean; fast?: boolean };
    expect(ack.deferred).toBe(true);
    expect(ack.fast).toBe(true);
    /* `_set_fast` has no running check — it mutates the live session's tier
       immediately; only the model leg defers (the gateway stashes it as
       pending_model_switch: sessionModels is NOT written yet). */
    expect(gw.configSetCalls.map((c) => c.key)).toEqual(["model", "fast"]);
    expect(gw.sessionFast.get(gw.lastSid)).toBe(true);
    expect(gw.sessionModels.get(gw.lastSid)).toBeUndefined();
    gw.complete(gw.lastSid);
    await p1;

    /* The next prompt goes straight to prompt.submit — no driver-side
       replay; the gateway's own stash applies the switch at turn start and
       re-reports it as session.info. turn.started stamps what the session
       ran AT start — the pre-apply model here, by design (the apply lands
       inside prompt_turn, after started goes out). */
    const callsBefore = gw.callLog.length;
    const p2 = promptAsync(h, sessionId);
    const started2 = await h.waitEvent(
      (e) =>
        e.type === "turn.started" &&
        (e.payload as { turnId?: string }).turnId === "t2",
    );
    expect((started2.payload as { model?: string }).model).toBe("stub-model-a");
    gw.complete(gw.lastSid);
    await p2;
    expect(
      gw.callLog.slice(callsBefore).filter((m) => m === "config.set"),
    ).toEqual([]);
    expect(gw.sessionModels.get(gw.lastSid)).toBe("devin/claude-opus-5");
    expect(gw.sessionEfforts.get(gw.lastSid)).toBe("high");
    // The applied pick shows on the FOLLOWING turn's turn.started.
    const p3 = promptAsync(h, sessionId);
    const started3 = await h.waitEvent(
      (e) =>
        e.type === "turn.started" &&
        (e.payload as { model?: string }).model === "devin/claude-opus-5",
    );
    expect((started3.payload as { fast?: boolean }).fast).toBe(true);
    expect((started3.payload as { effort?: string }).effort).toBe("high");
    gw.complete(gw.lastSid);
    await p3;
  });

  test("AC-4 a deferred switch that fails at turn start keeps the old model and the turn still runs", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    gw.runningSids.add(gw.lastSid);
    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "stub-model-b",
      provider: "stub",
    })) as { deferred?: boolean };
    expect(ack.deferred).toBe(true);
    gw.runningSids.delete(gw.lastSid);
    /* The stashed model is gone by the time the next turn applies it — the
       gateway emits `error {message}`. `error`/`notice` events stay
       unmapped (they also fire on user Stop, agent-init, resume failures —
       too broad for a system note); the harness never setModels mid-turn
       anyway, so only a raw protocol caller can reach this. The prompt
       still runs on the model the session kept (#92 review). */
    gw.failDeferredSwitch.add(gw.lastSid);

    const p = promptAsync(h, sessionId);
    const started = await h.waitEvent((e) => e.type === "turn.started");
    /* The failed apply never reached the session — turn.started carries no
       dead pick (the session never learned a model; stub-model-b is absent). */
    expect((started.payload as { model?: string }).model).toBeUndefined();
    gw.complete(gw.lastSid);
    const res = await p;
    expect(res.stopReason).toBe("end_turn");
    expect(gw.sessionModels.get(gw.lastSid)).toBeUndefined();
    expect(h.events.some((e) => e.type === "session.note")).toBe(false);
    // The NEXT turn's turn.started reports the kept default, not the dead pick.
    const p2 = promptAsync(h, sessionId);
    const started2 = await h.waitEvent(
      (e) =>
        e.type === "turn.started" &&
        (e.payload as { turnId?: string }).turnId === "t2",
    );
    expect((started2.payload as { model?: string }).model).toBe("stub-model-a");
    gw.complete(gw.lastSid);
    await p2;
  });

  test("AC-3 a fast leg the engine refuses (4002) omits `fast` from the ack; other codes still throw", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    /* stub-model-b's caps say no fast tier — `_set_fast` 4002s; the tier
       didn't change so the ack must not claim `fast:false`. */
    await h.request("session.setModel", {
      sessionId,
      model: "stub-model-b",
      provider: "stub",
    });
    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "stub-model-b",
      provider: "stub",
      fast: true,
    })) as { fast?: boolean };
    expect(ack.fast).toBeUndefined();
    expect(gw.sessionFast.get(gw.lastSid)).toBeUndefined();
    /* A non-4002 failure (transport, 5001…) still fails the whole pick. */
    gw.fastError = new RpcError(5001, "provider down");
    await expect(
      h.request("session.setModel", {
        sessionId,
        model: "stub-model-a",
        provider: "stub",
        fast: true,
      }),
    ).rejects.toMatchObject({ code: 5001 });
  });

  test("AC-8 a model id containing '/' round-trips verbatim via {provider, id}", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "devin/claude-opus-5",
      provider: "devin",
    })) as { model: string; provider?: string };
    expect(ack.model).toBe("devin/claude-opus-5");
    expect(ack.provider).toBe("devin");
    expect(gw.configSetCalls[0]?.value).toBe(
      "devin/claude-opus-5 --provider devin --session",
    );
    expect(gw.sessionModels.get(gw.lastSid)).toBe("devin/claude-opus-5");
    expect(gw.sessionProviders.get(gw.lastSid)).toBe("devin");
  });

  test("session.setModel error codes: -32001 / -32005 / -32003", async () => {
    const { h } = setup();
    await expect(
      h.request("session.setModel", { sessionId: "nope", model: "x" }),
    ).rejects.toMatchObject({ code: -32001 });
    const { sessionId } = await start(h);
    await expect(
      h.request("session.setModel", { sessionId, model: "no-such" }),
    ).rejects.toMatchObject({ code: -32005 });
    await h.request("session.stop", { sessionId });
    await expect(
      h.request("session.setModel", { sessionId, model: "stub-model-a" }),
    ).rejects.toMatchObject({ code: -32003 });
  });

  test("turn.started carries the ambient model when session.start omits one (#30)", async () => {
    const gw = new FakeGateway();
    const conn = connectInMemory(
      new HermesEngine({ gateway: gw, model: "stub-model-a" }),
    );
    const h = new Harness(conn);
    const { sessionId } = await start(h);
    const startedAt = h.events.length;
    const p = promptAsync(h, sessionId);
    const started = h.events
      .slice(startedAt)
      .find((e) => e.type === "turn.started");
    if (!started) throw new Error("turn.started missing");
    expect((started.payload as { model?: string }).model).toBe("stub-model-a");
    gw.complete(gw.lastSid);
    await p;
  });
});

describe("engine-hermes #179: subagents + background jobs", () => {
  test("AC-1 delegate turn emits flat subagent rows, nested tools grouped", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "delegate");
    await h.waitEvent((e) => e.type === "turn.started");

    // delegate_tool.py:288 spawn_requested at queue time; _progress_subagent
    // relays start/tool/complete frames with a stable subagent_id.
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_d",
      name: "delegate_task",
      args: {
        tasks: [
          { goal: "Scan the repo" },
          { goal: "Verify the fix" },
          { goal: "Draft the report" },
        ],
      },
    });
    const delegateStarted = h.events
      .filter(
        (e): e is Extract<EngineEvent, { type: "tool.started" }> =>
          e.type === "tool.started",
      )
      .at(-1);
    if (!delegateStarted) throw new Error("tool.started missing");
    const callId = delegateStarted.payload.toolCallId;
    for (let i = 0; i < 3; i++) {
      gw.emit(gw.lastSid, "subagent.start", {
        subagent_id: `sub-${i}`,
        task_index: i,
        task_count: 3,
        goal: ["Scan the repo", "Verify the fix", "Draft the report"][i],
      });
      gw.emit(gw.lastSid, "subagent.tool", {
        subagent_id: `sub-${i}`,
        task_index: i,
        tool_name: "read_file",
        tool_preview: `src/f${i}.ts`,
      });
      gw.emit(gw.lastSid, "subagent.complete", {
        subagent_id: `sub-${i}`,
        task_index: i,
        status: i === 1 ? "timeout" : "completed",
        summary: `task ${i} report`,
        duration_seconds: 1.2 + i,
      });
    }
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_d",
      name: "delegate_task",
      result: { status: "completed" },
      result_text: "3 of 3 tasks finished",
      duration_s: 4.2,
    });
    gw.complete(gw.lastSid);
    await p;

    const started = h.events.filter(
      (e): e is Extract<EngineEvent, { type: "subagent.started" }> =>
        e.type === "subagent.started",
    );
    expect(started).toHaveLength(3);
    expect(started.map((e) => e.payload.name)).toEqual([
      "task 1",
      "task 2",
      "task 3",
    ]);
    expect(started.map((e) => e.payload.task)).toEqual([
      "Scan the repo",
      "Verify the fix",
      "Draft the report",
    ]);
    for (const e of started) expect(e.payload.parentToolCallId).toBe(callId);

    const completed = h.events.filter(
      (e): e is Extract<EngineEvent, { type: "subagent.completed" }> =>
        e.type === "subagent.completed",
    );
    expect(completed).toHaveLength(3);
    const byId = new Map(started.map((e) => [e.payload.subagentId, e]));
    expect(
      completed.find((e) => e.payload.subagentId === [...byId.keys()][1])
        ?.payload.status,
    ).toBe("failed");
    expect(
      completed.find((e) => e.payload.subagentId === [...byId.keys()][0])
        ?.payload.result,
    ).toBe("task 0 report");

    const nested = h.events.filter(
      (e): e is Extract<EngineEvent, { type: "tool.started" }> =>
        e.type === "tool.started" && e.payload.parentToolCallId !== undefined,
    );
    expect(nested.length).toBeGreaterThanOrEqual(3);
    for (const e of nested)
      expect(byId.has(e.payload.parentToolCallId ?? "")).toBe(true);

    // seq replay: every emitted event replays verbatim, no dup rows.
    const replay = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { events: EngineEvent[] };
    const replayStarted = replay.events.filter(
      (e) => e.type === "subagent.started",
    );
    expect(replayStarted).toHaveLength(3);
    expect(
      new Set(
        replayStarted.map(
          (e) => (e.payload as { subagentId: string }).subagentId,
        ),
      ).size,
    ).toBe(3);
  });

  test("AC-4 backgrounded terminal mints a job row; output + close land", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "run dev");
    await h.waitEvent((e) => e.type === "turn.started");

    const proc = gw.pushProcess(gw.lastSid, {
      command: "bun run dev",
      tail: "$ bun run dev\n",
    });
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_t",
      name: "terminal",
      args: { command: "bun run dev", background: true },
    });
    // terminal_tool_background.py: the spawn result is a JSON string.
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_t",
      name: "terminal",
      result: JSON.stringify({
        output: "Background process started",
        session_id: proc.id,
        pid: proc.pid,
        exit_code: 0,
        error: null,
      }),
      duration_s: 0.4,
    });
    const jobStarted = await h.waitEvent((e) => e.type === "job.started");
    expect(jobStarted.payload).toMatchObject({
      jobId: proc.id,
      command: "bun run dev",
    });
    gw.complete(gw.lastSid);
    await p;

    // Desktop sink: agent.terminal.output carries the registry id + chunk.
    gw.emit(gw.lastSid, "agent.terminal.output", {
      process_id: proc.id,
      chunk: "  ➜  Local:   http://localhost:4173/\n",
    });
    const out = await h.waitEvent(
      (e) =>
        e.type === "job.output" &&
        String((e.payload as { tail: string }).tail).includes("4173"),
    );
    expect(out.payload).toMatchObject({
      jobId: proc.id,
      url: "http://localhost:4173/",
    });

    // terminal.close carries the OS pid; the row reconciles via process.list.
    proc.exited = true;
    proc.exitCode = 0;
    proc.reason = "exited";
    proc.tail += "done\n";
    gw.emit(gw.lastSid, "terminal.close", { process_id: proc.pid });
    const exited = await h.waitEvent((e) => e.type === "job.exited");
    expect(exited.payload).toMatchObject({
      jobId: proc.id,
      status: "exited",
      exitCode: 0,
    });
  });

  test("AC-4 jobs.list + jobs.stop over process.*; 2nd stop reads stopped:false", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const proc = gw.pushProcess(gw.lastSid, {
      command: "bun run test --watch",
      tail: "watching…\n",
    });

    const list = (await h.request("jobs.list", { sessionId })) as {
      jobs: { jobId: string; command: string; status: string }[];
    };
    expect(list.jobs.map((j) => j.jobId)).toContain(proc.id);
    expect(list.jobs[0].status).toBe("running");

    const exitedP = h.waitEvent((e) => e.type === "job.exited");
    const stopped = (await h.request("jobs.stop", {
      sessionId,
      jobId: proc.id,
    })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect((await exitedP).payload).toMatchObject({
      jobId: proc.id,
      status: "stopped",
    });

    const again = (await h.request("jobs.stop", {
      sessionId,
      jobId: proc.id,
    })) as { stopped: boolean };
    expect(again.stopped).toBe(false);
    const missing = (await h.request("jobs.stop", {
      sessionId,
      jobId: "proc-nope",
    })) as { stopped: boolean };
    expect(missing.stopped).toBe(false);
  });

  test("AC-4 timeout-yielded terminal call mints the job too", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    await h.waitEvent((e) => e.type === "turn.started");
    gw.pushProcess(gw.lastSid, { command: "bun test" });
    const proc = gw.processes.at(-1);
    if (!proc) throw new Error("no proc");
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_y",
      name: "terminal",
      args: { command: "bun test" },
    });
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_y",
      name: "terminal",
      result: JSON.stringify({
        status: "yielded_to_background",
        session_id: proc.id,
        pid: proc.pid,
      }),
      duration_s: 30.1,
    });
    const started = await h.waitEvent((e) => e.type === "job.started");
    expect(started.payload).toMatchObject({
      jobId: proc.id,
      command: "bun test",
    });
    gw.complete(gw.lastSid);
    await p;
  });

  test("AC-5 describe declares subagents + background_jobs", async () => {
    const { h } = setup();
    const d = (await h.request("describe")) as {
      capabilities: { id: string; methods?: string[] }[];
    };
    expect(d.capabilities.map((c) => c.id)).toEqual(
      expect.arrayContaining(["subagents", "background_jobs"]),
    );
    expect(
      d.capabilities.find((c) => c.id === "background_jobs")?.methods,
    ).toEqual(["jobs.list", "jobs.stop"]);
  });
});

describe("engine-hermes #140 AC-2: setModel re-checks the live catalog once", () => {
  test("a pick the cached list omits but refresh offers validates — an id missing from both fails early", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);

    /* The account-gated case: the cached `model.options` read omits
       gpt-6-astra; the LIVE read offers it (what Refresh shows the user).
       `refreshProviders` models join modelProviders on the first
       {refresh:true} call, like the gateway's updated disk cache. */
    gw.refreshProviders = [
      { slug: "codex", name: "Codex", models: ["gpt-6-astra"] },
    ];
    const ack = (await h.request("session.setModel", {
      sessionId,
      model: "gpt-6-astra",
      provider: "codex",
    })) as { model: string; provider?: string };
    expect(ack.model).toBe("gpt-6-astra");
    expect(ack.provider).toBe("codex");
    // Validation read once unrefreshed, then once with refresh:true.
    expect(gw.modelOptionsCalls.map((c) => c.refresh === true)).toEqual([
      false,
      true,
    ]);
    expect(gw.configSetCalls.map((c) => c.key)).toEqual(["model"]);

    // An id missing from BOTH reads still fails early (#50 AC-3 kept).
    await expect(
      h.request("session.setModel", { sessionId, model: "no-such-model" }),
    ).rejects.toMatchObject({ code: -32005 });
    expect(gw.configSetCalls.filter((c) => c.key === "model")).toHaveLength(1);
  });
});

describe("engine-hermes #294: the resolved context window reaches clients", () => {
  test("usage.context_max maps to Usage.contextWindow on turn.completed", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    // The gateway's `_get_usage` merge — the fake emits context_max 262k.
    gw.complete(gw.lastSid);
    await p;
    const done = h.events.find((e) => e.type === "turn.completed");
    if (!done) throw new Error("turn.completed missing");
    const usage = (done.payload as { usage?: { contextWindow?: number } })
      .usage;
    expect(usage?.contextWindow).toBe(262_000);
  });

  test("session.info's usage.context_max refreshes the window between turns", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.complete(gw.lastSid);
    await p;
    /* A mid-session config change (a deferred model switch re-resolving the
       window) reports through session.info's usage field — the snapshot's
       usage follows it before the next turn ends. */
    gw.emit(gw.lastSid, "session.info", {
      model: "stub-model-b",
      usage: { context_max: 128_000 },
    });
    const snap = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { snapshot: { usage?: { contextWindow?: number } } };
    expect(snap.snapshot.usage?.contextWindow).toBe(128_000);
  });

  test("models.list derives contextWindow only from an explicit [Nm]/[Nk] id suffix", async () => {
    const { gw, h } = setup();
    gw.modelProviders = [
      {
        slug: "anthropic-cliproxy",
        name: "Anthropic – CLIProxyAPI",
        models: ["claude-sonnet-5[1m]", "qwen3.8[262k]", "claude-opus-4.8"],
      },
    ];
    const r = (await h.request("models.list")) as {
      models: { id: string; contextWindow?: number }[];
    };
    expect(
      r.models.find((m) => m.id === "claude-sonnet-5[1m]")?.contextWindow,
    ).toBe(1_000_000);
    expect(r.models.find((m) => m.id === "qwen3.8[262k]")?.contextWindow).toBe(
      262_000,
    );
    // No suffix → nothing claimed: the client's labelled estimate handles it.
    expect(
      r.models.find((m) => m.id === "claude-opus-4.8")?.contextWindow,
    ).toBeUndefined();
  });
});

/* #288: a harness restart kills `hermes serve` and this adapter with it —
   the new process binds each conversation through `events.since(engineRef)`.
   With the persisted registry the adapter resumes the SAME stored Hermes
   session under the same engine id (no session.create, no fresh transcript,
   no `setTitle` collision); without a row the rebind falls back like before. */
describe("engine-hermes #288: restart resumes the stored session", () => {
  const file = () =>
    join(
      mkdtempSync(join(tmpdir(), "lilos-hermes-sessions-")),
      "engine-sessions.json",
    );

  test("events.since on a dead id resumes the stored session under the same engine id", async () => {
    const sessionsFile = file();
    const gw = new FakeGateway();
    const engine1 = new HermesEngine({ gateway: gw, sessionsFile });
    const h1 = new Harness(connectInMemory(engine1));
    const { sessionId } = await start(h1, {
      model: "stub-model-b",
      provider: "stub",
    });
    const p1 = promptAsync(h1, sessionId, "first");
    gw.complete(gw.lastSid);
    await p1;
    // Adapter dies with the harness (sessions map emptied, rows persisted).
    await engine1.close();

    const engine2 = new HermesEngine({ gateway: gw, sessionsFile });
    const h2 = new Harness(connectInMemory(engine2));
    const replay = (await h2.request("events.since", {
      sessionId,
      after: 0,
    })) as {
      events: { sessionId: string }[];
      snapshot: { state: string };
    };
    // Resolved (not SESSION_NOT_FOUND): the resumed session registered under
    // the SAME engine id — the conversation's engineRef never moves.
    expect(replay.events[0]?.sessionId).toBe(sessionId);
    expect(replay.snapshot.state).toBe("idle");

    // Eager resume on the STORED id under the session's profile — no
    // session.create, so no second stored session and no title collision.
    expect(gw.resumeCalls).toHaveLength(1);
    expect(gw.resumeCalls[0].session_id).toBe("ref-1");
    expect(gw.resumeCalls[0].profile).toBe("builder");
    expect(gw.resumeCalls[0].eager_build).toBe(true);
    expect(gw.resumeCalls[0].omit_messages).toBe(true);
    expect(gw.resumeCalls[0].close_on_disconnect).toBe(true);
    expect(gw.createCalls).toHaveLength(1);
    // The session's pick rides config.set onto the rebuilt agent — the
    // stored row doesn't carry model/provider, and a bare resume prompts
    // against profile defaults ("No LLM provider configured" refusals).
    const resumedRuntime = gw.lastSid;
    expect(
      gw.configSetCalls.some(
        (c) =>
          c.session_id === resumedRuntime &&
          c.key === "model" &&
          String(c.value).includes("--provider stub"),
      ),
    ).toBe(true);

    // The next prompt lands on the resumed runtime session — the same
    // stored Hermes session continues, memory intact.
    const resumedSid = gw.lastSid;
    const p2 = promptAsync(h2, sessionId, "second");
    gw.complete(resumedSid);
    const res = await p2;
    expect(res.stopReason).toBe("end_turn");
    expect(gw.lastPrompt?.session_id).toBe(resumedSid);
    expect(gw.createCalls).toHaveLength(1);
    // userTurns survived the restart (session.rewind's toTurn baseline).
    const s = engine2.sessionFor(sessionId);
    expect(s?.userTurns).toBe(2);
  });

  test("events.since on an id the registry never held still answers SESSION_NOT_FOUND", async () => {
    const sessionsFile = file();
    const engine = new HermesEngine({
      gateway: new FakeGateway(),
      sessionsFile,
    });
    const h = new Harness(connectInMemory(engine));
    await expect(
      h.request("events.since", { sessionId: "s-zzz-1", after: 0 }),
    ).rejects.toMatchObject({ code: -32001 }); // SESSION_NOT_FOUND
  });

  test("a resume the gateway can't serve falls back (registry row survives)", async () => {
    const sessionsFile = file();
    const gw1 = new FakeGateway();
    const h1 = new Harness(
      connectInMemory(new HermesEngine({ gateway: gw1, sessionsFile })),
    );
    const { sessionId } = await start(h1);
    // A DIFFERENT gateway (fresh hermes serve, empty store) — resume 404s,
    // the caller must still get SESSION_NOT_FOUND to fall back on.
    const gw2 = new FakeGateway();
    const engine2 = new HermesEngine({ gateway: gw2, sessionsFile });
    const h2 = new Harness(connectInMemory(engine2));
    await expect(
      h2.request("events.since", { sessionId, after: 0 }),
    ).rejects.toMatchObject({ code: -32001 });
    expect(gw2.resumeCalls).toHaveLength(1);
  });

  test("session ids are namespaced across adapter restarts (#61 parity)", async () => {
    const sessionsFile = file();
    const h1 = new Harness(
      connectInMemory(
        new HermesEngine({ gateway: new FakeGateway(), sessionsFile }),
      ),
    );
    const a = await start(h1);
    const h2 = new Harness(
      connectInMemory(
        new HermesEngine({ gateway: new FakeGateway(), sessionsFile }),
      ),
    );
    const b = await start(h2);
    /* A fresh counter must never re-mint an id a persisted row owns —
       otherwise the second process's s1 row clobbers the first's, and a
       later rebind resumes the wrong stored session. */
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).toMatch(/^s-\w+-\d+$/);
  });
});

describe("engine-hermes #308: post-turn legs mint their own turn", () => {
  /* Live capture (scripts/live/309.ts): a queued steer drains post-turn as
     `session.state running` + `message.start` + deltas stamped on the
     SETTLED turn id + a second `turn.completed` — no `turn.started`. The
     engine must mint the leg a real turn so its frames don't merge into
     the finished one. */
  test("a queued steer drains as its own turn carrying the steer message's ref", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;
    const [t1] = h.events
      .filter((e) => e.type === "turn.started")
      .map((e) => (e.payload as { turnId: string }).turnId);

    const steer = (await h.request("session.steer", {
      sessionId,
      text: "quick one",
      ref: "msg_B",
    })) as { status: string };
    expect(steer.status).toBe("steered");

    // The queued steer drains post-turn as its own leg.
    gw.emit(gw.lastSid, "message.start", {});
    gw.emit(gw.lastSid, "message.delta", { text: "the quick answer" });
    gw.complete(gw.lastSid);
    await new Promise((r) => setTimeout(r, 0));

    const started = h.events.filter((e) => e.type === "turn.started");
    expect(started).toHaveLength(2);
    const leg = started[1].payload as {
      turnId: string;
      ref?: string;
      initiatedBy?: string;
    };
    expect(leg.turnId).not.toBe(t1);
    expect(leg.ref).toBe("msg_B");
    /* The leg's deltas and its completion stamp the leg's own id — they
       must not land on the settled t1. */
    const idsOf = (type: string) =>
      h.events
        .filter((e) => e.type === type)
        .map((e) => (e.payload as { turnId: string }).turnId);
    expect(idsOf("turn.delta").at(-1)).toBe(leg.turnId);
    expect(idsOf("turn.completed").at(-1)).toBe(leg.turnId);
  });

  test("an engine-initiated leg mints an agent-initiated turn with no ref", async () => {
    /* Subagent-result delivery / auto-continue: the engine opens a leg
       itself — own agent entry, agent-initiated, never anchored to a user
       message. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;

    gw.emit(gw.lastSid, "message.start", {});
    gw.emit(gw.lastSid, "message.delta", { text: "ZEBRA report" });
    gw.complete(gw.lastSid);
    await new Promise((r) => setTimeout(r, 0));

    const started = h.events.filter((e) => e.type === "turn.started");
    expect(started).toHaveLength(2);
    const leg = started[1].payload as {
      turnId: string;
      ref?: string;
      initiatedBy?: string;
    };
    expect(leg.initiatedBy).toBe("agent");
    expect(leg.ref).toBeUndefined();
  });

  test("a prompt sent mid-leg still lands (legs aren't prompt turns)", async () => {
    /* Minting must not reuse s.turn — prompt() throws INVALID_STATE on a
       running turn, and a delivery leg is no place to start rejecting
       user input. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;

    gw.emit(gw.lastSid, "message.start", {});
    const p2 = promptAsync(h, sessionId, "during the leg");
    gw.emit(gw.lastSid, "message.delta", { text: "leg text" });
    gw.complete(gw.lastSid);
    gw.emit(gw.lastSid, "message.delta", { text: "answer B" });
    gw.complete(gw.lastSid);
    await expect(p2).resolves.toMatchObject({ stopReason: "end_turn" });
  });
});
