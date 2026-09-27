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
      capabilities: { id: string; methods?: string[] }[];
    };
    const agents = d.capabilities.find((c) => c.id === "agents");
    const models = d.capabilities.find((c) => c.id === "models");
    expect(agents?.methods).toEqual([
      "agents.list",
      "agents.describe",
      "agents.create",
    ]);
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
       replay; the gateway's own stash applies the switch at turn start. */
    const callsBefore = gw.callLog.length;
    const p2 = promptAsync(h, sessionId);
    await h.waitEvent(
      (e) =>
        e.type === "turn.started" &&
        (e.payload as { model?: string }).model === "devin/claude-opus-5",
    );
    expect(gw.callLog.slice(callsBefore)).toEqual(["prompt.submit"]);
    expect(gw.sessionModels.get(gw.lastSid)).toBe("devin/claude-opus-5");
    expect(gw.sessionEfforts.get(gw.lastSid)).toBe("high");
    const started = h.events.find(
      (e) =>
        e.type === "turn.started" &&
        (e.payload as { model?: string }).model === "devin/claude-opus-5",
    );
    expect((started?.payload as { fast?: boolean })?.fast).toBe(true);
    expect((started?.payload as { effort?: string })?.effort).toBe("high");
    gw.complete(gw.lastSid);
    await p2;
  });

  test("AC-4 a deferred switch that fails at turn start posts a session.note and the turn still runs", async () => {
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
       gateway emits `error {message}`; the engine must surface it and let
       the prompt proceed on the current model (no jam, no turn failure). */
    gw.failDeferredSwitch.add(gw.lastSid);

    const p = promptAsync(h, sessionId);
    const note = await h.waitEvent((e) => e.type === "session.note");
    expect((note.payload as { text: string }).text).toContain(
      "Could not switch model",
    );
    expect(gw.sessionModels.get(gw.lastSid)).toBeUndefined();
    gw.complete(gw.lastSid);
    const res = await p;
    expect(res.stopReason).toBe("end_turn");
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
