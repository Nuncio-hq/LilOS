import { mkdtempSync, readFileSync } from "node:fs";
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

describe("engine-hermes #334: reasoning.available is a summary, not a delta", () => {
  test("the summary frame never reaches the reasoning stream", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);

    /* The reported case — real wire order captured on `hermes serve`
       v0.21.5+3173: no chain-of-thought, so the
       summary frame carries the assistant's own message text. */
    const p1 = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "message.delta", { text: "\n\n391" });
    gw.emit(gw.lastSid, "reasoning.available", { text: "391" });
    gw.complete(gw.lastSid, { text: "391" });
    await p1;

    /* The general case — a real reasoning stream followed by the
       summary; the answer must not append onto the thought. */
    const p2 = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "reasoning.delta", { text: "340+51 = 391." });
    gw.emit(gw.lastSid, "message.delta", { text: "391" });
    gw.emit(gw.lastSid, "reasoning.available", { text: "391" });
    gw.complete(gw.lastSid, { text: "391" });
    await p2;

    const byTurn = new Map<string, { reasoning: string; text: string }>();
    for (const e of h.events) {
      if (e.type !== "turn.delta") continue;
      const p = e.payload as { turnId: string; stream: string; delta: string };
      const t = byTurn.get(p.turnId) ?? { reasoning: "", text: "" };
      if (p.stream === "reasoning") t.reasoning += p.delta;
      else t.text += p.delta;
      byTurn.set(p.turnId, t);
    }
    const turns = [...byTurn.values()];
    expect(turns).toHaveLength(2);
    expect(turns[0]?.reasoning).toBe("");
    expect(turns[0]?.text).toBe("\n\n391");
    expect(turns[1]?.reasoning).toBe("340+51 = 391.");
    expect(turns[1]?.text).toBe("391");
  });
});

describe("engine-hermes #414: message.interim seals a segment, not appends", () => {
  /** Concatenate the text stream the way turn-model's `t.text` folds it. */
  const textOf = (h: Harness, turnId: string) =>
    h.events
      .filter(
        (e) =>
          e.type === "turn.delta" &&
          (e.payload as { stream?: string }).stream === "text" &&
          (e.payload as { turnId?: string }).turnId === turnId,
      )
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
  const turnIdOf = (h: Harness) => {
    const e = h.events.find((x) => x.type === "turn.started");
    if (!e) throw new Error("turn.started missing");
    return (e.payload as { turnId: string }).turnId;
  };

  test("AC-2 recorded sequence: streamed pre-tool text renders once", async () => {
    /* Wire order captured on real `hermes serve` (the issue's live check)
       for "the agent says something, then calls a tool" — upstream
       (tui_gateway/prompt_turn.py `_interim_assistant_cb` <-
       agent/stream_delivery.py `_emit_interim_assistant_message`):
         1. message.delta xN — the commentary streams
         2. message.interim {text:<same>, already_streamed:true} — the
            mid-turn segment is SEALED; the text is the segment's
            authoritative full content, not a delta
         3. tool.start / tool.complete — the calls from that message run
         4. message.delta — the final answer
         5. message.complete — turn end                                        */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const said =
      "No test framework is set up in this repo (no package.json), so I'll write the test using node:test.";
    const p = promptAsync(h, sessionId, "add a subtract function and a test");
    gw.emit(gw.lastSid, "message.delta", { text: said.slice(0, 60) });
    gw.emit(gw.lastSid, "message.delta", { text: said.slice(60) });
    gw.emit(gw.lastSid, "message.interim", {
      text: said,
      already_streamed: true,
    });
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_1",
      name: "write_file",
      args: { path: "subtract.test.mjs" },
    });
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_1",
      name: "write_file",
      result_text: "wrote subtract.test.mjs",
    });
    gw.emit(gw.lastSid, "message.delta", { text: "Done: subtract() + test." });
    gw.complete(gw.lastSid, { text: "Done: subtract() + test." });
    await p;

    /* The bug: the interim's text was appended AGAIN as a turn.delta —
       the thread rendered the sentence twice. */
    expect(textOf(h, turnIdOf(h))).toBe(`${said}Done: subtract() + test.`);
  });

  test("a non-streamed interim (already_streamed:false) emits its text once", async () => {
    /* The other half of the contract: non-streaming providers and the
       Codex runtime route whole completed messages through interim —
       the frame is then the text's only carrier and MUST emit. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "message.interim", {
      text: "Checking the folder first.",
      already_streamed: false,
    });
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_1",
      name: "terminal",
      args: { command: "ls" },
    });
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_1",
      name: "terminal",
      result_text: "files",
    });
    gw.emit(gw.lastSid, "message.interim", {
      text: "Done.",
      already_streamed: false,
    });
    gw.complete(gw.lastSid, { text: "Done." });
    await p;

    expect(textOf(h, turnIdOf(h))).toBe("Checking the folder first.Done.");
  });

  test("an interim longer than what streamed emits only the missing tail", async () => {
    /* Partial stream (flag absent/false): the segment's text starts with
       what already streamed — resending the whole frame would re-print
       the head. Only the unstreamed suffix goes out (upstream replaces
       its buffer with the authoritative text). */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "message.delta", { text: "Let me check the" });
    gw.emit(gw.lastSid, "message.interim", {
      text: "Let me check the repo.",
      already_streamed: false,
    });
    gw.emit(gw.lastSid, "message.delta", { text: "Done." });
    gw.complete(gw.lastSid, { text: "Done." });
    await p;

    expect(textOf(h, turnIdOf(h))).toBe("Let me check the repo.Done.");
  });

  test("an interim identical to the stream without the flag stays single", async () => {
    /* Defensive: an older/shaped frame that omits `already_streamed` but
       re-carries exactly what message.delta delivered still seals — the
       tracked stream makes the flag unnecessary here. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "message.delta", { text: "Looking into it." });
    gw.emit(gw.lastSid, "message.interim", { text: "Looking into it." });
    gw.emit(gw.lastSid, "message.delta", { text: "Done." });
    gw.complete(gw.lastSid, { text: "Done." });
    await p;

    expect(textOf(h, turnIdOf(h))).toBe("Looking into it.Done.");
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
    // #106: every offered choice carries through, session grant included.
    expect(req.options).toEqual(["once", "session", "always", "deny"]);
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

describe("engine-hermes #106: approval modes", () => {
  type Describe = {
    capabilities: { id: string; detail?: { current?: string } }[];
  };
  const capCurrent = async (h: Harness) =>
    ((await h.request("describe")) as Describe).capabilities.find(
      (c) => c.id === "approval_policy",
    )?.detail?.current;

  test("AC-3 approvals.setPolicy -> config.set approvals.mode; describe reports current", async () => {
    const { gw, h } = setup();
    // `current` seeds from config.get when no setPolicy ran yet.
    expect(await capCurrent(h)).toBe("smart");
    expect(await h.request("approvals.setPolicy", { policy: "off" })).toEqual({
      policy: "off",
    });
    expect(
      gw.configSetCalls.find((c) => c.key === "approvals.mode"),
    ).toMatchObject({ value: "off" });
    expect(gw.approvalsMode).toBe("off");
    expect(await capCurrent(h)).toBe("off");
  });

  test("AC-1 access:full on session.start sends the session yolo hint; session.setAccess toggles it", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h, { access: "full" });
    expect(gw.sessionYolo.get(gw.lastSid)).toBe(true);
    expect(gw.configSetCalls).toContainEqual(
      expect.objectContaining({
        key: "yolo",
        value: "on",
        scope: "session",
      }),
    );
    expect(
      await h.request("session.setAccess", { sessionId, access: "ask" }),
    ).toEqual({ access: "ask" });
    expect(gw.sessionYolo.get(gw.lastSid)).toBe(false);
    // A plain start sends no hint — Ask is the transport's own default.
    const { sessionId: s2 } = await start(h);
    expect(s2).toBeTruthy();
    expect(gw.sessionYolo.get(gw.lastSid)).toBeUndefined();
  });

  test("AC-4 a 'session' outcome maps to wire choice session", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    const ask = gw.ask(gw.lastSid, "approval", {
      request_id: "r9",
      command: "rm -rf x",
      choices: ["once", "session", "always", "deny"],
    });
    const opened = await h.waitEvent((e) => e.type === "request.opened");
    const requestId = (opened.payload as { requestId: string }).requestId;
    await h.request("request.respond", {
      sessionId,
      requestId,
      outcome: "session",
    });
    expect((await ask).result).toEqual({ choice: "session" });
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

  test("AC-5c stopped session answers like a missing one: prompt -> -32001", async () => {
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
    ).rejects.toMatchObject({ code: -32001 });
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

  test("session.setModel error codes: -32001 / -32005", async () => {
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
    ).rejects.toMatchObject({ code: -32001 }); // #573: stopped = forgotten
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

  test("usage.context_used maps to Usage.context — occupancy, not throughput (#415)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    /* The fake emits the real `_get_usage` split: input/output are
       session-lifetime sums, context_used is the live occupancy. #415's
       123.2% repro came from dividing the lifetime sum by the window. */
    gw.complete(gw.lastSid);
    await p;
    const done = h.events.find((e) => e.type === "turn.completed");
    if (!done) throw new Error("turn.completed missing");
    const usage = (done.payload as { usage?: { context?: number } }).usage;
    expect(usage?.context).toBe(18);
  });

  test("a mid-turn session.usage tick refreshes the live occupancy (#415)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.complete(gw.lastSid);
    await p;
    /* `session.usage` ticks carry the same `_get_usage` shape — the meter's
       snapshot follows a drifting occupancy between turn ends. */
    gw.emit(gw.lastSid, "session.usage", {
      usage: { context_used: 41_000, context_max: 262_000 },
    });
    const snap = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as {
      snapshot: { usage?: { context?: number; contextWindow?: number } };
    };
    expect(snap.snapshot.usage?.context).toBe(41_000);
    expect(snap.snapshot.usage?.contextWindow).toBe(262_000);
  });

  test("a mid-turn occupancy tick survives a completion that omits context fields (#415)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p1 = promptAsync(h, sessionId);
    gw.complete(gw.lastSid); // seeds s.usage (context: 18)
    await p1;
    const p2 = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "session.usage", {
      usage: { context_used: 41_000, context_max: 262_000 },
    });
    /* An older/partial `_get_usage` shape that reports neither field must
       not drop the tick's reading back to the lifetime-sum fallback —
       the same preserve the ACP endAcpTurn applies. */
    gw.complete(gw.lastSid, { usage: { input: 900, output: 60 } });
    await p2;
    const dones = h.events.filter((e) => e.type === "turn.completed");
    const usage = (dones[1].payload as { usage?: Record<string, number> })
      .usage;
    expect(usage?.context).toBe(41_000);
    expect(usage?.contextWindow).toBe(262_000);
    expect(usage?.input).toBe(900);
  });

  test("a real context_used: 0 maps through — post-compaction occupancy is not 'unreported' (#415)", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.complete(gw.lastSid, {
      usage: {
        input: 900,
        output: 60,
        context_used: 0,
        context_max: 262_000,
      },
    });
    await p;
    const done = h.events.find((e) => e.type === "turn.completed");
    if (!done) throw new Error("no turn.completed");
    const usage = (done.payload as { usage?: Record<string, number> }).usage;
    /* 0 stays 0 — falling back to input+output here would inflate the
       meter right after a compaction. */
    expect(usage?.context).toBe(0);
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
  /* Live capture: a queued steer drains post-turn as
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

  test("a prompt sent mid-leg is rejected; the leg keeps its own id", async () => {
    /* #308 review: prompt() while a leg ran used to mint a prompt turn —
       the leg's frames then stamped on the prompt turn, the completion
       cleared legTurnId without closing the leg (stuck Working), and the
       prompt's answer minted a leg of its own. Mid-work user input goes
       through session.steer (queued as the next leg) — prompt mid-leg is
       the same misuse as prompt mid-turn: INVALID_STATE. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;

    gw.emit(gw.lastSid, "message.start", {});
    await expect(promptAsync(h, sessionId, "during the leg")).rejects.toThrow(
      /running turn/,
    );

    gw.emit(gw.lastSid, "message.delta", { text: "leg text" });
    gw.complete(gw.lastSid);
    await new Promise((r) => setTimeout(r, 0));

    const started = h.events.filter((e) => e.type === "turn.started");
    expect(started).toHaveLength(2);
    const legId = (started[1].payload as { turnId: string }).turnId;
    const idsOf = (type: string) =>
      h.events
        .filter((e) => e.type === type)
        .map((e) => (e.payload as { turnId: string }).turnId);
    expect(idsOf("turn.delta").at(-1)).toBe(legId);
    expect(idsOf("turn.completed").at(-1)).toBe(legId);
  });

  test("Stop during a live leg interrupts it and drops queued steers", async () => {
    /* #308 review: interrupt() early-returned on !s.turn, so Stop was dead
       while a leg ran and a queued steer survived it. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;

    gw.emit(gw.lastSid, "message.start", {});
    await new Promise((r) => setTimeout(r, 0));
    const steer = (await h.request("session.steer", {
      sessionId,
      text: "queued behind the leg",
      ref: "msg_C",
    })) as { status: string };
    expect(steer.status).toBe("steered");

    const r = (await h.request("interrupt", { sessionId })) as {
      interrupted: boolean;
    };
    expect(r.interrupted).toBe(true);

    gw.complete(gw.lastSid, { status: "interrupted" });
    await new Promise((r2) => setTimeout(r2, 0));
    gw.emit(gw.lastSid, "message.start", {});
    gw.complete(gw.lastSid);
    await new Promise((r2) => setTimeout(r2, 0));
    /* The queued steer was dropped with the interrupt: the next leg mints
       agent-initiated, never carrying msg_C's ref. */
    const legs = h.events
      .filter((e) => e.type === "turn.started")
      .map(
        (e) =>
          e.payload as { turnId: string; ref?: string; initiatedBy?: string },
      );
    expect(legs).toHaveLength(3);
    expect(legs[2].initiatedBy).toBe("agent");
    expect(legs[2].ref).toBeUndefined();
  });

  test("a stray turn.completed with no open turn or leg is dropped", async () => {
    /* #308 review: a doubled message.complete used to stamp `lastTurnId`
       and emit a bogus turn.completed on a settled turn. */
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "first");
    gw.emit(gw.lastSid, "message.delta", { text: "answer A" });
    gw.complete(gw.lastSid);
    await p;

    const completed = () =>
      h.events.filter((e) => e.type === "turn.completed").length;
    const before = completed();
    gw.complete(gw.lastSid);
    await new Promise((r) => setTimeout(r, 0));
    expect(completed()).toBe(before);
  });
});

describe("engine-hermes #416: an inline diff carries the file's real path", () => {
  /* tui_gateway's ToolCompletePayload has no top-level `path` — the file a
     write call touched lives in `args` (the tool's own input). Reading
     `payload.path` stamped every diff "(inline)", which collapsed the turn
     footer's unique-path count to 1. */
  const diffPathOf = async (
    completePayload: Record<string, unknown>,
  ): Promise<string | undefined> => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "edit files");
    gw.emit(gw.lastSid, "tool.start", {
      tool_id: "call_1",
      name: "write_file",
      args: { path: "x" },
    });
    gw.emit(gw.lastSid, "tool.complete", {
      tool_id: "call_1",
      name: "write_file",
      result: { ok: true },
      inline_diff: "a/x → b/x +1",
      ...completePayload,
    });
    gw.complete(gw.lastSid);
    await p;
    const done = h.events.find((e) => e.type === "tool.completed")?.payload as {
      diff?: { path?: string };
    };
    return done.diff?.path;
  };

  test("AC-1 args.path names the file (write_file / patch replace)", async () => {
    expect(
      await diffPathOf({ args: { path: "math.test.ts", content: "…" } }),
    ).toBe("math.test.ts");
  });

  test("AC-1 V4A patch headers name the file (delete/update/add)", async () => {
    expect(
      await diffPathOf({
        args: {
          mode: "patch",
          patch:
            "*** Begin Patch\n*** Delete File: old.ts\n*** Update File: keep.ts\n*** End Patch",
        },
      }),
    ).toBe("old.ts");
  });

  test("a legacy top-level path or missing args still falls back", async () => {
    expect(await diffPathOf({ path: "legacy.ts" })).toBe("legacy.ts");
    expect(await diffPathOf({ args: null })).toBe("(inline)");
  });
});

/* #431: the adapter's per-session log is bounded (D-#431) and a finished
   turn's streams replay as one recap — the WS and resume paths share
   Session.emit, so the hook covers every event source. */
describe("engine-hermes #431: compact replay + bounded log", () => {
  test("a finished turn's deltas replay as one turn.recap", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    gw.emit(gw.lastSid, "reasoning.delta", { text: "think" });
    gw.emit(gw.lastSid, "message.delta", { text: "answer" });
    gw.complete(gw.lastSid, { text: "answer" });
    const { turnId } = await p;

    const since = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { events: EngineEvent[]; truncated: boolean };
    const turnEvents = since.events.filter(
      (e) => (e.payload as { turnId?: string }).turnId === turnId,
    );
    expect(turnEvents.filter((e) => e.type === "turn.delta")).toEqual([]);
    const recaps = turnEvents.filter((e) => e.type === "turn.recap");
    expect(recaps).toHaveLength(1);
    expect((recaps[0].payload as { text: string }).text).toBe("answer");
    expect((recaps[0].payload as { reasoning: string }).reasoning).toBe(
      "think",
    );
    // Log-only: a live listener never sees a recap frame.
    expect(h.events.map((e) => e.type)).not.toContain("turn.recap");
  });

  test("eventLogCap bounds the log and events.since reports truncation", async () => {
    const gw = new FakeGateway();
    const h = new Harness(
      connectInMemory(new HermesEngine({ gateway: gw, eventLogCap: 8 })),
    );
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId);
    for (let i = 0; i < 10; i++)
      gw.emit(gw.lastSid, "message.delta", { text: `w${i} ` });
    gw.complete(gw.lastSid, { text: "w" });
    await p;

    const since = (await h.request("events.since", {
      sessionId,
      after: 0,
    })) as { events: EngineEvent[]; truncated: boolean };
    expect(since.events.length).toBeLessThanOrEqual(8);
    expect(since.truncated).toBe(true);
    const tail = (await h.request("events.since", {
      sessionId,
      after: since.events[0].seq,
    })) as { truncated: boolean };
    expect(tail.truncated).toBe(false);
  });
});

/* #482 review pass: the death settle and the heal must each be TOTAL —
   a throwing listener can't strand the next session's `done`, a turn that
   dies mid-completion-await can't settle twice, and the create-fallback
   must rebind every field a dead row implied (stored ref + access hint). */
describe("engine-hermes #482: settle + heal invariants", () => {
  test("markBackendDown fails every in-flight turn typed even when a listener throws", async () => {
    const { gw, engine, h } = setup();
    const a = await start(h);
    /* A running job on a — the settle's emitJobExited fires a job.exited
       event the throwing listener will kill mid-settle, BEFORE a's own
       refusal emit. The turn's reject must still land (finally). */
    const proc = gw.pushProcess(gw.lastSid, {
      command: "sleep 99",
      tail: "",
    });
    /* The engine only learns the registry row when a frame names it — an
       output chunk mints the tracked job before the kill. */
    gw.emit(gw.lastSid, "agent.terminal.output", {
      process_id: proc.id,
      chunk: "x\n",
    });
    const b = await start(h);
    const pa = promptAsync(h, a.sessionId, "hi");
    const pb = promptAsync(h, b.sessionId, "hi");
    engine.onEvent((e) => {
      if (
        e.sessionId === a.sessionId &&
        (e.type === "turn.completed" || e.type === "job.exited")
      )
        throw new Error("listener bug");
    });
    engine.markBackendDown("test kill");
    await expect(pa).rejects.toMatchObject({ code: -32006 });
    await expect(pb).rejects.toMatchObject({ code: -32006 });
    /* a's own refusal emit was skipped by the early throw — the caller's
       reject and the error state still landed from `finally`. The job row
       was marked failed before its event emit threw, proving the loop ran. */
    expect(
      h.events.filter(
        (e) => e.type === "turn.completed" && e.sessionId === a.sessionId,
      ),
    ).toHaveLength(0);
    expect(engine.sessionFor(a.sessionId)?.jobs.get(proc.id)?.status).toBe(
      "failed",
    );
    expect(engine.sessionFor(a.sessionId)?.state).toBe("error");
    const bRefusal = h.events.filter(
      (e) => e.type === "turn.completed" && e.sessionId === b.sessionId,
    );
    expect(bRefusal).toHaveLength(1);
    expect((bRefusal[0].payload as { stopReason: string }).stopReason).toBe(
      "refusal",
    );
    const sb = engine.sessionFor(b.sessionId);
    expect(sb?.backendDead).toBe(true);
    expect(sb?.state).toBe("error");
    gw.close();
  });

  test("#521 markBackendDown stamps the typed errorCode on the refusal frame", async () => {
    const { engine, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "hi");
    engine.markBackendDown("gateway socket closed");
    await expect(p).rejects.toMatchObject({ code: -32006 });
    const done = h.events.filter((e) => e.type === "turn.completed");
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      stopReason: "refusal",
      errorCode: -32006,
    });
  });

  test("#521 a typed prompt.submit rejection stamps errorCode on the refusal frame", async () => {
    const { gw, h } = setup();
    const { sessionId } = await start(h);
    /* The gateway-close-first ordering: the submit call is the one parked
       when the backend dies — its typed reject reaches the caller AND the
       refusal frame, both carrying -32006. */
    gw.submitError = new RpcError(
      -32006,
      "hermes backend is down (gateway socket closed)",
    );
    const p = promptAsync(h, sessionId, "hi");
    await expect(p).rejects.toMatchObject({ code: -32006 });
    const done = h.events.filter((e) => e.type === "turn.completed");
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      stopReason: "refusal",
      errorCode: -32006,
    });
    expect((done[0].payload as { error?: string }).error).toContain(
      "hermes backend is down",
    );
  });

  test("a turn whose backend dies mid-completion-await settles exactly once", async () => {
    const { gw, engine, h } = setup();
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "hi");
    /* Hold completeTurn's post-turn session.title poll, kill the backend
       inside that await, then let the poll answer — the pre-fix engine
       emitted a second turn.completed (end_turn) over the refusal and
       flipped the session back to idle mid-outage. */
    let release!: () => void;
    gw.titleGate = new Promise<void>((r) => {
      release = r;
    });
    gw.complete(gw.lastSid);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (gw.callLog.includes("session.title")) return resolve();
        if (Date.now() > deadline)
          return reject(new Error("session.title poll never fired"));
        setTimeout(tick, 5);
      };
      tick();
    });
    engine.markBackendDown("kill mid-title-poll");
    release();
    await expect(p).rejects.toMatchObject({ code: -32006 });
    // Let the released title answer unwind through completeTurn.
    await new Promise((r) => setTimeout(r, 20));
    const dones = h.events.filter((e) => e.type === "turn.completed");
    expect(dones).toHaveLength(1);
    expect((dones[0].payload as { stopReason: string }).stopReason).toBe(
      "refusal",
    );
    expect(engine.sessionFor(sessionId)?.state).toBe("error");
  });

  test("the resume-fail heal rebinds the new stored row and re-applies access", async () => {
    const sessionsFile = join(
      mkdtempSync(join(tmpdir(), "lilos-hermes-sessions-")),
      "engine-sessions.json",
    );
    const gw1 = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw1, sessionsFile });
    const h = new Harness(connectInMemory(engine));
    const { sessionId } = await start(h, { access: "ask" });
    const s = engine.sessionFor(sessionId);
    expect(s?.ref).toBe("ref-1");

    engine.markBackendDown("kill");
    /* A fresh backend has no stored rows: session.resume 4040s and the
       engine must fall back to session.create. Burn one ref id first (no
       stored row) so the fallback's new stored id is provably different. */
    const gw2 = new FakeGateway();
    gw2.burnRefs(1);
    engine.setGateway(gw2);

    await h.request("session.setTitle", { sessionId, title: "x" });
    expect(gw2.resumeCalls).toHaveLength(1);
    expect(gw2.resumeCalls[0].session_id).toBe("ref-1");
    expect(gw2.createCalls).toHaveLength(1);
    expect(s?.runtimeSid).toBe(gw2.lastSid);
    /* The persisted row must name the NEW stored ref or the next adapter
       restart would resume the abandoned pre-fallback session — every
       turn since silently out of memory. */
    expect(s?.ref).toBe("ref-2");
    /* access:"ask" rides yolo=off onto the freshly created agent. */
    expect(
      gw2.configSetCalls.some(
        (c) =>
          c.key === "yolo" && c.value === "off" && c.session_id === gw2.lastSid,
      ),
    ).toBe(true);
    expect(s?.backendDead).toBe(false);

    const p = promptAsync(h, sessionId, "after heal");
    gw2.complete(gw2.lastSid);
    expect((await p).stopReason).toBe("end_turn");
    expect(gw2.lastPrompt?.session_id).toBe(gw2.lastSid);
    await engine.close();
  });
});

/* #573: session.stop is forget — the stopped Session leaves the adapter's
   maps (sessions + byRuntimeSid; acpDrivers already dropped on close), so
   engine memory stops tracking every session ever opened. A forgotten id
   answers SESSION_NOT_FOUND like a never-seen one; the harness degrades it
   to an empty closed transcript (D-#300). */
describe("engine-hermes #573: session.stop forgets the session", () => {
  test("AC-1 stop evicts the session from sessions + byRuntimeSid", async () => {
    const { gw, engine, h } = setup();
    const a = await start(h);
    const b = await start(h);
    expect(engine.sessionCount).toBe(2);
    const runtimeSid = engine.sessionFor(a.sessionId)?.runtimeSid;
    expect(typeof runtimeSid).toBe("string");

    const stopped = (await h.request("session.stop", {
      sessionId: a.sessionId,
    })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(engine.sessionCount).toBe(1);
    expect(engine.sessionFor(a.sessionId)).toBeUndefined();
    expect(engine.sessionIdFor(runtimeSid as string)).toBeUndefined();
    expect(gw.closedSessions).toContain(runtimeSid);

    /* The forgotten id answers like a never-seen one — nothing to prompt,
       replay, or stop twice. */
    await expect(
      h.request("events.since", { sessionId: a.sessionId, after: 0 }),
    ).rejects.toMatchObject({ code: -32001 });
    await expect(promptAsync(h, a.sessionId)).rejects.toMatchObject({
      code: -32001,
    });
    await expect(
      h.request("session.stop", { sessionId: a.sessionId }),
    ).rejects.toMatchObject({ code: -32001 });

    /* The surviving session still runs. */
    const p = promptAsync(h, b.sessionId);
    gw.complete(gw.lastSid);
    await expect(p).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  test("AC-1 stop on a suspended session drops the registry row — no resurrect", async () => {
    const sessionsFile = join(
      mkdtempSync(join(tmpdir(), "lilos-hermes-sessions-")),
      "engine-sessions.json",
    );
    const gw = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw, sessionsFile });
    const h = new Harness(connectInMemory(engine));
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "hi");
    gw.complete(gw.lastSid);
    await p;

    /* Suspend evicts the live session but keeps the durable row — the next
       replay/prompt would session.resume it (#346). */
    await h.request("session.suspend", { sessionId });
    expect(engine.sessionFor(sessionId)).toBeUndefined();
    const rows = () =>
      (
        JSON.parse(readFileSync(sessionsFile, "utf8")) as {
          sessions: Record<string, unknown>;
        }
      ).sessions;
    expect(rows()[sessionId]).toBeDefined();

    /* Ending a suspended session for good owns the row too — otherwise a
       later events.since would resurrect a stopped session. */
    const stopped = (await h.request("session.stop", {
      sessionId,
    })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(rows()[sessionId]).toBeUndefined();
    await expect(
      h.request("events.since", { sessionId, after: 0 }),
    ).rejects.toMatchObject({ code: -32001 });
    expect(gw.resumeCalls).toHaveLength(0); // never resurrected
  });

  /* The resume paths await the gateway before writing the maps back — a
     session.stop landing inside that window must not be undone when the
     resume answer arrives: the minted runtime session is closed server-
     side and the forgotten id stays forgotten. */
  test("AC-1 stop while a suspended session's resume is in flight doesn't resurrect it", async () => {
    const sessionsFile = join(
      mkdtempSync(join(tmpdir(), "lilos-hermes-sessions-")),
      "engine-sessions.json",
    );
    const gw = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw, sessionsFile });
    const h = new Harness(connectInMemory(engine));
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "hi");
    gw.complete(gw.lastSid);
    await p;
    await h.request("session.suspend", { sessionId });
    expect(engine.sessionCount).toBe(0);

    let release!: () => void;
    gw.resumeGate = new Promise<void>((r) => {
      release = r;
    });
    /* events.since parks inside resumeStored's session.resume. */
    const replay = h.request("events.since", { sessionId, after: 0 });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (gw.resumeCalls.length) return resolve();
        if (Date.now() > deadline)
          return reject(new Error("session.resume never fired"));
        setTimeout(tick, 5);
      };
      tick();
    });

    const stopped = (await h.request("session.stop", {
      sessionId,
    })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);

    release();
    await expect(replay).rejects.toMatchObject({ code: -32001 });
    expect(engine.sessionFor(sessionId)).toBeUndefined();
    /* The resume minted sid-2 — the engine closed the orphan rather than
       registering it (sid-1 is suspend's close). */
    expect(gw.closedSessions).toEqual(["sid-1", "sid-2"]);
  });

  test("AC-1 stop while a backendDead resume is in flight doesn't resurrect it", async () => {
    const sessionsFile = join(
      mkdtempSync(join(tmpdir(), "lilos-hermes-sessions-")),
      "engine-sessions.json",
    );
    const gw1 = new FakeGateway();
    const engine = new HermesEngine({ gateway: gw1, sessionsFile });
    const h = new Harness(connectInMemory(engine));
    const { sessionId } = await start(h);
    const p = promptAsync(h, sessionId, "hi");
    gw1.complete(gw1.lastSid);
    await p;

    engine.markBackendDown("kill");
    const gw2 = new FakeGateway();
    /* Burn a ref so the minted sid is provably distinct from sid-1, and
       seed the stored row the new backend kept across restart — without
       it session.resume 4040s synchronously (never reaching the gate) and
       the create fallback decides the race on microtask timing. */
    gw2.burnRefs(1);
    gw2.seedStored("ref-1");
    let release!: () => void;
    gw2.resumeGate = new Promise<void>((r) => {
      release = r;
    });
    engine.setGateway(gw2);

    /* The prompt parks inside ensureLive's session.resume on gw2. */
    const prompt = promptAsync(h, sessionId, "hi");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (gw2.resumeCalls.length) return resolve();
        if (Date.now() > deadline)
          return reject(new Error("session.resume never fired"));
        setTimeout(tick, 5);
      };
      tick();
    });

    const stopped = (await h.request("session.stop", {
      sessionId,
    })) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(engine.sessionFor(sessionId)).toBeUndefined();

    release();
    await expect(prompt).rejects.toMatchObject({ code: -32001 });
    /* gw2 saw stop's session.close on the stale sid plus the engine's
       close of the minted orphan — nothing re-registered. */
    expect(gw2.closedSessions).toEqual(["sid-1", "sid-2"]);
    expect(engine.sessionIdFor("sid-2")).toBeUndefined();
  });
});

describe("engine-hermes #549: lilos toolset self-heal + tool-offer log", () => {
  const BACKEND = { url: "http://127.0.0.1:55000", token: "tok-backend" };

  test("AC-3: session.start logs the tools the model would get", async () => {
    const gw = new FakeGateway();
    const logs: string[] = [];
    const engine = new HermesEngine({
      gateway: gw,
      onLog: (l) => logs.push(l),
    });
    const conn = connectInMemory(engine);
    const h = new Harness(conn);
    await start(h);
    const line = logs.find((l) => l.includes("offered"));
    expect(line).toBeTruthy();
    expect(line).toContain("lilos_context");
    expect(line).toContain(gw.lastSid);
    /* A backend that already has the plugin loaded skips the POST. */
    expect(logs.some((l) => l.includes("active on our backend"))).toBe(true);
    await engine.close();
  });

  test("lilos toolset missing on a record-less backend → activate on OUR backend before create, then offered", async () => {
    const gw = new FakeGateway();
    /* The enable nudge landed on the host owner's record — OUR backend's
       plugin manager never loaded lilos, and its toolsets lack it. */
    gw.plugins = [];
    gw.toolsets = gw.toolsets.filter((t) => t.name !== "lilos");
    const posts: { url: string; init?: RequestInit }[] = [];
    const logs: string[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), init });
      // The real endpoint flips the backend's registry before returning:
      // plugins.list then reports it and the next tools.list resolves its
      // tools for a session created after activation.
      gw.plugins = [{ name: "lilos", enabled: true }];
      gw.toolsets = [
        ...gw.toolsets,
        {
          name: "lilos",
          description: "LilOS app surfaces",
          tool_count: 2,
          enabled: true,
          tools: ["lilos_context", "lilos_team_list"],
        },
      ];
      return new Response("{}", { status: 200 });
    };
    const engine = new HermesEngine({
      gateway: gw,
      onLog: (l) => logs.push(l),
      hermesHome: "/tmp/hh",
      fetchFn,
    });
    const conn = connectInMemory(engine);
    const h = new Harness(conn);
    // The supervisor reports the backend endpoint on gateway attach.
    engine.setGateway(gw, BACKEND);
    await start(h);
    /* The POST ran BEFORE session.create — the new agent's pinned list
       was built with the plugin already registered. */
    const pluginsList = gw.callLog.indexOf("plugins.list");
    const create = gw.callLog.indexOf("session.create");
    expect(pluginsList).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(pluginsList);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post.url).toBe(
      `${BACKEND.url}/api/dashboard/agent-plugins/activate`,
    );
    expect(JSON.parse(String(post.init?.body))).toEqual({
      name: "lilos",
      home: "/tmp/hh/profiles/builder",
    });
    expect(post.init?.headers).toMatchObject({
      "X-Hermes-Session-Token": "tok-backend",
    });
    expect(logs.some((l) => l.includes("activated on our backend"))).toBe(true);
    await engine.close();
  });

  test("missing lilos with no endpoint → logs the gap, session still starts", async () => {
    const gw = new FakeGateway();
    gw.plugins = [];
    gw.toolsets = gw.toolsets.filter((t) => t.name !== "lilos");
    const logs: string[] = [];
    const engine = new HermesEngine({
      gateway: gw,
      onLog: (l) => logs.push(l),
      hermesHome: "/tmp/hh",
    });
    const conn = connectInMemory(engine);
    const h = new Harness(conn);
    const { sessionId } = await start(h);
    expect(sessionId).toBeTruthy();
    expect(logs.some((l) => l.includes("no backend endpoint"))).toBe(true);
    /* And the post-create verify names what the session is missing. */
    expect(logs.some((l) => l.includes("no lilos_* tools offered"))).toBe(true);
    await engine.close();
  });
});
