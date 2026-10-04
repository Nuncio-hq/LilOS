import { describe, expect, test } from "vitest";
import { MODEL_CATALOG } from "../src/catalog.js";
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
      // Same namespace seed → identical session ids across runs (#61).
      const c = connectFake(
        new FakeEngine({ tick: 1, sessionNamespace: "det" }),
      );
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

  test("AC-1 session ids are namespaced per engine run, never reused after restart", async () => {
    const start = async (c: ReturnType<typeof conn>) =>
      (
        (await c.request("session.start", { agent: "builder", cwd: "/t" })) as {
          sessionId: string;
        }
      ).sessionId;
    // Each FakeEngine is one engine run (#61): a restarted engine must never
    // hand out an id a previous run already used, or a stale events.since /
    // prompt could alias onto a stranger's fresh session.
    const run1 = conn();
    const run2 = conn();
    const [r1a, r1b] = [await start(run1), await start(run1)];
    const r2a = await start(run2);
    expect(r1a).not.toBe(r1b);
    expect([r1a, r1b]).not.toContain(r2a);
    run1.close();
    run2.close();

    // Seedable: a fixed namespace keeps ids fully deterministic for tests.
    const seeded = () =>
      connectFake(new FakeEngine({ tick: 1, sessionNamespace: "test" }));
    expect(await start(seeded())).toBe(await start(seeded()));
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
      "image_prompt",
      "mcp_servers",
      "agents",
      "models",
      "session_meta",
      "rewind",
      "plan",
      "subagents",
      "background_jobs",
      "approval_policy",
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

  test("AC-2 an image content block is accepted and the answer names it", async () => {
    const c = conn();
    const seen: { type: string; stream?: string; delta?: string }[] = [];
    c.onEvent((e) => {
      const payload = e.payload as { stream?: string; delta?: string };
      seen.push({ type: e.type, stream: payload.stream, delta: payload.delta });
    });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    const res = (await c.request("prompt", {
      sessionId,
      content: [
        { type: "text", text: "what's in this shot" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    })) as { stopReason: string };
    expect(res.stopReason).toBe("end_turn");
    const text = seen
      .filter((e) => e.type === "turn.delta" && e.stream === "text")
      .map((e) => e.delta)
      .join("");
    // The fake can't see pixels; it echoes the metadata it was handed,
    // proving the block crossed the seam ("aGk=" is 2 bytes of "hi").
    expect(text).toContain("image/png (2 bytes)");
    c.close();
  });

  test("an engine without image_prompt still rejects image blocks", async () => {
    const c = connectFake(
      new FakeEngine({ tick: 1, capabilities: { image_prompt: false } }),
    );
    const r = (await c.request("describe")) as {
      capabilities: { id: string }[];
    };
    expect(r.capabilities.map((x) => x.id)).not.toContain("image_prompt");
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

  test("#106 approval policy + access hint + session grant scope", async () => {
    const c = conn();
    type Describe = {
      capabilities: { id: string; detail?: { current?: string } }[];
    };
    // The engine declares its global policy with a live `current` (AC-6).
    const d1 = (await c.request("describe")) as Describe;
    expect(
      d1.capabilities.find((x) => x.id === "approval_policy")?.detail?.current,
    ).toBe("smart");
    expect(
      await c.request("approvals.setPolicy", { policy: "manual" }),
    ).toEqual({ policy: "manual" });
    const d2 = (await c.request("describe")) as Describe;
    expect(
      d2.capabilities.find((x) => x.id === "approval_policy")?.detail?.current,
    ).toBe("manual");
    await expect(
      c.request("approvals.setPolicy", { policy: "yolo" }),
    ).rejects.toMatchObject({ code: -32602 });

    // session.start stamps the conversation's access; session.setAccess
    // pushes a switch onto the live session.
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
      access: "full",
    })) as { sessionId: string };
    expect(
      await c.request("session.setAccess", { sessionId, access: "ask" }),
    ).toEqual({ access: "ask" });

    // The ask offers Once / This session / Always / Deny (AC-4).
    const events: { type: string; payload: any }[] = [];
    c.onEvent((e) => events.push(e as never));
    const p = promptText(c, sessionId, "Fix the README title");
    const deadline = Date.now() + 5_000;
    let ask = events.find((e) => e.type === "request.opened");
    while (!ask && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      ask = events.find((e) => e.type === "request.opened");
    }
    if (!ask) throw new Error("no request.opened event");
    expect((ask.payload.request as { options: string[] }).options).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ]);

    // "This session" resolves the ask…
    await c.request("request.respond", {
      sessionId,
      requestId: ask.payload.requestId,
      outcome: "session",
    });
    // …then drain the rest of the canned turn with "once".
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    const answered = new Set<string>([ask?.payload.requestId as string]);
    const deadline2 = Date.now() + 5_000;
    while (!settled && Date.now() < deadline2) {
      for (const e of events) {
        if (e.type !== "request.opened") continue;
        const requestId = e.payload.requestId as string;
        if (answered.has(requestId)) continue;
        answered.add(requestId);
        await c.request("request.respond", {
          sessionId,
          requestId,
          outcome: "once",
        });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await p;

    // A NEW session re-asks the same command — a "session" grant never
    // leaks into the permanent allowlist the way "always" does.
    const { sessionId: s2 } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    const events2: typeof events = [];
    c.onEvent((e) => events2.push(e as never));
    const p2 = promptText(c, s2, "Fix the README title");
    const deadline3 = Date.now() + 5_000;
    let ask2 = events2.find((e) => e.type === "request.opened");
    while (!ask2 && Date.now() < deadline3) {
      await new Promise((r) => setTimeout(r, 5));
      ask2 = events2.find((e) => e.type === "request.opened");
    }
    expect(ask2).toBeTruthy();
    await c.request("interrupt", { sessionId: s2 });
    await expect(p2).resolves.toMatchObject({ stopReason: "cancelled" });
    c.close();
  });

  test("#106 without approval_policy the methods are unknown and describe omits it", async () => {
    const c = connectFake(
      new FakeEngine({ capabilities: { approval_policy: false } }),
    );
    const r = (await c.request("describe")) as {
      capabilities: { id: string }[];
    };
    expect(r.capabilities.map((x) => x.id)).not.toContain("approval_policy");
    await expect(
      c.request("approvals.setPolicy", { policy: "off" }),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      c.request("session.setAccess", { sessionId: "x", access: "full" }),
    ).rejects.toMatchObject({ code: -32601 });
    c.close();
  });

  test("AC-2 steer on an idle session reports not_running and starts no turn", async () => {
    const c = conn();
    const seen: string[] = [];
    c.onEvent((e) => seen.push(e.type));
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    const ack = (await c.request("session.steer", {
      sessionId,
      text: "nobody home",
    })) as { status: string };
    expect(ack.status).toBe("not_running");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).not.toContain("turn.started");
    // The session is untouched: a normal prompt still works and runs its turn.
    await promptText(c, sessionId, "Explain the relay package");
    expect(seen.filter((t) => t === "turn.started").length).toBe(1);
    c.close();
  });

  test("AC-2 without the steer capability the method is unknown and describe omits it", async () => {
    const c = connectFake(new FakeEngine({ capabilities: { steer: false } }));
    const r = (await c.request("describe")) as {
      capabilities: { id: string; methods?: string[] }[];
    };
    expect(r.capabilities.map((x) => x.id)).not.toContain("steer");
    expect(r.capabilities.map((x) => x.id)).toContain("mcp_servers");
    await expect(
      c.request("session.steer", { sessionId: "s1", text: "hi" }),
    ).rejects.toMatchObject({ code: -32601 });
    c.close();
  });

  test("AC-4 a deferred pick that fails at turn start posts session.note and still answers on the old model", async () => {
    const c = conn(30);
    const notes: string[] = [];
    const startedModels: (string | undefined)[] = [];
    c.onEvent((e) => {
      if (e.type === "session.note")
        notes.push((e.payload as { text: string }).text);
      if (e.type === "turn.started")
        startedModels.push((e.payload as { model?: string }).model);
    });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };

    // Pick mid-turn → deferred to the stash.
    const p1 = promptText(c, sessionId, "one");
    const deadline = Date.now() + 5_000;
    while (!startedModels.length && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const ack = (await c.request("session.setModel", {
      sessionId,
      model: "fake/opus-2",
      provider: "fake",
      effort: "high",
    })) as { deferred?: boolean };
    expect(ack.deferred).toBe(true);
    await p1;

    /* The stashed model is gone by the time the next turn applies it — a
       refresh dropped it. The apply must post a pick-specific note and run
       the turn on the CURRENT model, never jam and never fail the prompt
       (#92 review). MODEL_CATALOG is the fake's only mutable surface. */
    const i = MODEL_CATALOG.findIndex((m) => m.id === "fake/opus-2");
    const removed = MODEL_CATALOG.splice(i, 1)[0];
    try {
      const p2 = promptText(c, sessionId, "two");
      const noteDeadline = Date.now() + 5_000;
      while (!notes.length && Date.now() < noteDeadline)
        await new Promise((r) => setTimeout(r, 5));
      const res = await p2;
      expect(res.stopReason).toBe("end_turn");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("Couldn't switch to fake/opus-2");
      expect(notes[0]).toContain("staying on");
      // The turn ran on the model it already had (the session default).
      expect(startedModels.at(-1)).toBe("fake-large");
    } finally {
      MODEL_CATALOG.push(removed);
    }
    c.close();
  });

  test("AC-5 the first turn emits a derived title, then an llm title (#137)", async () => {
    const c = conn();
    const events: { type: string; seq: number; payload: unknown }[] = [];
    c.onEvent((e) =>
      events.push({
        type: e.type,
        seq: e.seq,
        payload: e.payload,
      }),
    );
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-fake",
    })) as { sessionId: string };
    await promptText(c, sessionId, "Explain the relay package to me");

    const titled = events
      .filter((e) => e.type === "session.titled")
      .map((e) => e.payload as { title: string; source: string });
    expect(titled.map((t) => t.source)).toEqual(["derived", "llm"]);
    expect(titled[0].title).toBe("Explain the relay package to me");
    expect(titled[1].title).not.toBe(titled[0].title);

    // Ordering: derived arrives with the first turn; llm upgrades at its end
    // — both strictly seq-ordered (assertMonotonic covered by conformance).
    const titledSeqs = events
      .filter((e) => e.type === "session.titled")
      .map((e) => e.seq);
    const startedSeq = events.find((e) => e.type === "turn.started")?.seq ?? 0;
    const completedSeq =
      events.find((e) => e.type === "turn.completed")?.seq ?? 0;
    expect(titledSeqs[0]).toBeGreaterThan(startedSeq);
    expect(titledSeqs[0]).toBeLessThan(completedSeq);
    expect(titledSeqs[1]).toBeGreaterThan(titledSeqs[0]);

    // Snapshot carries the settled title so a replaying harness lands it.
    const since = (await c.request("events.since", {
      sessionId,
      after: 0,
    })) as { snapshot: { title?: string } };
    expect(since.snapshot.title).toBe(titled[1].title);

    // Second turn: titles are a once-per-session write, not per-turn.
    await promptText(c, sessionId, "Explain the store package to me");
    expect(events.filter((e) => e.type === "session.titled")).toHaveLength(2);
    c.close();
  });

  test("AC-5 a user title (session.setTitle) blocks engine title writes (#137)", async () => {
    const c = conn();
    const events: { type: string; payload: unknown }[] = [];
    c.onEvent((e) => events.push({ type: e.type, payload: e.payload }));
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-fake",
    })) as { sessionId: string };

    // setTitle BEFORE any turn → the whole auto-title leg is suppressed
    // `user` provenance outranks `derived`/`llm`.
    await c.request("session.setTitle", {
      sessionId,
      title: "My session",
    });
    await promptText(c, sessionId, "Explain the relay package to me");
    expect(events.filter((e) => e.type === "session.titled")).toHaveLength(0);
    c.close();

    // setTitle mid-turn-1 → the derived title already landed (it fires at
    // turn start) but the llm upgrade must not.
    const c2 = conn();
    const events2: { type: string; payload: unknown }[] = [];
    c2.onEvent((e) => events2.push({ type: e.type, payload: e.payload }));
    const { sessionId: s2 } = (await c2.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-fake",
    })) as { sessionId: string };
    const pending = promptText(c2, s2, "Add a footer to the page"); // asks
    const deadline = Date.now() + 5_000;
    let ask = events2.find((e) => e.type === "request.opened");
    while (!ask && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      ask = events2.find((e) => e.type === "request.opened");
    }
    expect(ask).toBeTruthy();
    await c2.request("session.setTitle", {
      sessionId: s2,
      title: "Footer work",
    });
    // The canned turn asks more than once — answer each open request until
    // the prompt settles.
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    const answered = new Set<string>();
    const deadline2 = Date.now() + 5_000;
    while (!settled && Date.now() < deadline2) {
      for (const e of events2) {
        if (e.type !== "request.opened") continue;
        const requestId = (e.payload as { requestId: string }).requestId;
        if (answered.has(requestId)) continue;
        answered.add(requestId);
        await c2.request("request.respond", {
          sessionId: s2,
          requestId,
          outcome: "once",
        });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await pending;
    const titled = events2
      .filter((e) => e.type === "session.titled")
      .map((e) => e.payload as { source: string });
    expect(titled.map((t) => t.source)).toEqual(["derived"]);
    c2.close();
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

describe("engine-fake #140 AC-2: a refresh-only model validates only once a refresh was served", () => {
  /* Mirrors the real adapter's gate (account-gated model absent from the cached
     read, offered by the live one): `session.setModel` for fake-fresh fails
     before any models.list {refresh:true}, and passes after it. */
  test("fake-fresh: MODEL_NOT_FOUND before a refresh; the pick works after", async () => {
    const c = conn();
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };

    await expect(
      c.request("session.setModel", { sessionId, model: "fake-fresh" }),
    ).rejects.toMatchObject({ code: -32005 });

    const listed = (await c.request("models.list", {
      refresh: true,
    })) as { models: { id: string }[] };
    expect(listed.models.map((m) => m.id)).toContain("fake-fresh");
    // Once served, the model stays in the catalog (the gateway's cache
    // updates the same way).
    const cached = (await c.request("models.list", {})) as {
      models: { id: string }[];
    };
    expect(cached.models.map((m) => m.id)).toContain("fake-fresh");

    const ack = (await c.request("session.setModel", {
      sessionId,
      model: "fake-fresh",
    })) as { model: string };
    expect(ack.model).toBe("fake-fresh");

    // …and a never-listed id still fails early.
    await expect(
      c.request("session.setModel", { sessionId, model: "no-such" }),
    ).rejects.toMatchObject({ code: -32005 });
    c.close();
  });
});

describe("engine-fake #432: `slow[:ms]` paces only the marked prompt", () => {
  test("AC-1 `slow:<ms>` stretches one turn's boundaries; the next turn runs at the engine tick", async () => {
    const c = conn(5);
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };

    /* The default script is ~55 sleep boundaries: 40 ms → a multi-second
       turn; a pace that leaked past its turn would stretch the follow-up
       the same way. */
    const t0 = Date.now();
    await promptText(c, sessionId, "slow:40 take your time");
    const slowMs = Date.now() - t0;
    const t1 = Date.now();
    await promptText(c, sessionId, "follow-up at normal pace");
    const fastMs = Date.now() - t1;
    expect(slowMs).toBeGreaterThanOrEqual(1_500);
    expect(fastMs).toBeLessThan(1_000);
    c.close();
  });

  test("AC-1 `slow:` strips before script routing — `slow: leg:` still arms the agent-initiated leg", async () => {
    const c = conn(5);
    const started: { initiatedBy?: string }[] = [];
    const deltas: { stream?: string; delta?: string }[] = [];
    c.onEvent((e) => {
      if (e.type === "turn.started")
        started.push(e.payload as { initiatedBy?: string });
      if (e.type === "turn.delta")
        deltas.push(e.payload as { stream?: string; delta?: string });
    });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    await promptText(c, sessionId, "slow:20 leg:ZEBRA report delivered");
    /* The leg lands asynchronously after the prompt's turn.completed —
       wait for its delivered text. */
    const legText = () =>
      deltas.some(
        (d) => d.stream === "text" && d.delta === "ZEBRA report delivered",
      );
    const deadline = Date.now() + 10_000;
    while (!legText() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(started).toHaveLength(2);
    expect(started[1].initiatedBy).toBe("agent");
    expect(legText()).toBe(true);
    c.close();
  });

  test("AC-1 `slowleg:<ms>` paces only the armed leg — the arming turn runs at the engine tick", async () => {
    const c = conn(5);
    const starts: { initiatedBy?: string; t: number }[] = [];
    const ends: { initiatedBy?: string; t: number }[] = [];
    const t0 = Date.now();
    c.onEvent((e) => {
      if (e.type === "turn.started")
        starts.push({ ...(e.payload as object), t: Date.now() - t0 });
      if (e.type === "turn.completed")
        ends.push({ ...(e.payload as object), t: Date.now() - t0 });
    });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    /* The prompt turn is a normal-speed turn (~50 boundaries at 5 ms);
       only the leg it arms gets the ~1 s window. */
    await promptText(c, sessionId, "slowleg:80 leg:ZEBRA report delivered");
    const deadline = Date.now() + 10_000;
    while (ends.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(starts).toHaveLength(2);
    expect(starts[1].initiatedBy).toBe("agent");
    const promptMs = ends[0].t - starts[0].t;
    const legMs = ends[1].t - starts[1].t;
    expect(promptMs).toBeLessThan(1_000);
    expect(legMs).toBeGreaterThanOrEqual(700);
    c.close();
  });
});

describe("engine-fake #294: reports the session's context window", () => {
  test("models.list rows carry the engine's window only where the engine reports one", async () => {
    const c = conn();
    const listed = (await c.request("models.list", {})) as {
      models: { id: string; contextWindow?: number }[];
    };
    expect(
      listed.models.find((m) => m.id === "fake-large")?.contextWindow,
    ).toBe(262_000);
    expect(
      listed.models.find((m) => m.id === "fake-reasoning")?.contextWindow,
    ).toBe(200_000);
    /* fake/opus-2 deliberately reports none — it keeps the client's "~"
       estimate path testable (#294). */
    expect(
      listed.models.find((m) => m.id === "fake/opus-2")?.contextWindow,
    ).toBeUndefined();
    c.close();
  });

  test("turn.completed usage carries the session model's window, following a switch", async () => {
    const c = conn();
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    c.onEvent((e) =>
      events.push(e as { type: string; payload: Record<string, unknown> }),
    );
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
      model: "fake-large",
    })) as { sessionId: string };
    await promptText(c, sessionId, "Explain the relay package");
    const lastUsage = () => {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type !== "turn.completed") continue;
        return (events[i].payload as { usage?: { contextWindow?: number } })
          .usage;
      }
      return undefined;
    };
    expect(lastUsage()?.contextWindow).toBe(262_000);

    // Switching to a model with no reported window clears it — no stale row.
    await c.request("session.setModel", {
      sessionId,
      model: "fake/opus-2",
    });
    await promptText(c, sessionId, "one more");
    expect(lastUsage()?.contextWindow).toBeUndefined();
    c.close();
  });

  test("turn.completed usage carries live occupancy in `context`, clamped to the window (#415)", async () => {
    const c = conn();
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    c.onEvent((e) =>
      events.push(e as { type: string; payload: Record<string, unknown> }),
    );
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
      model: "fake-large",
    })) as { sessionId: string };
    await promptText(c, sessionId, "hi");
    const done = events.find((e) => e.type === "turn.completed");
    if (!done) throw new Error("no turn.completed");
    const usage = (
      done.payload as {
        usage?: {
          input: number;
          output: number;
          context?: number;
          contextWindow?: number;
        };
      }
    ).usage;
    /* The fake runs one call per turn — the whole billed sum stays in
       context, so `context` equals in+out here, clamped to the window like
       a real compressor's reading. */
    expect(usage?.context).toBe((usage?.input ?? 0) + (usage?.output ?? 0));
    expect(usage?.context).toBeLessThanOrEqual(usage?.contextWindow ?? 0);
    c.close();
  });
});

describe("engine-fake #524: an interrupt inside the subagent-close drain leaks no rejection", () => {
  /* `finishTurn` schedules `void this.drainSubagentCloses(s)` with no
     `.catch`; the drain's first statement is `await this.sleep(s)`, and
     `sleep` throws `Interrupted` when `s.turn?.interrupted`. `finishTurn`
     clears `s.turn` before scheduling, but a prompt landing inside the
     drain's single sleep window mints a NEW turn — interrupting (or
     stopping) it inside the window throws out of the drain and escapes
     the `void`'d call as an unhandled rejection. The listener below must
     stay empty. */
  const trackUnhandled = () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    return {
      unhandled,
      off: () => process.off("unhandledRejection", onUnhandled),
    };
  };

  /* Arms an async delegate on a `slow:` turn — the first helper's close
     queues in `pendingSubagentClose` and `finishTurn` opens the drain's
     one-tick sleep (~60 ms). The returned `next` prompt lands inside that
     window: `slow:100` mints its turn and parks it in a 100 ms first
     boundary, so it is still minted — and newly interrupted — when the
     drain wakes. */
  const armDrain = async (c: ReturnType<typeof conn>) => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    c.onEvent((e) => events.push(e as never));
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/t",
    })) as { sessionId: string };
    await promptText(
      c,
      sessionId,
      "slow:60 LILOS_DELEGATE_ASYNC delegate the scan to a helper",
    );
    const next = promptText(c, sessionId, "slow:100 the follow-up turn");
    return { sessionId, events, next };
  };

  const snapshot = async (c: ReturnType<typeof conn>, sessionId: string) =>
    (
      (await c.request("events.since", { sessionId, after: 0 })) as {
        snapshot: { state: string; turn?: unknown };
      }
    ).snapshot;

  test("AC-1 interrupt inside the drain's sleep: the queued close still lands, the new turn settles cancelled, the session answers — no unhandled rejection", async () => {
    const { unhandled, off } = trackUnhandled();
    const c = conn(2);
    try {
      const { sessionId, events, next } = await armDrain(c);
      const ack = (await c.request("interrupt", { sessionId })) as {
        interrupted: boolean;
      };
      expect(ack.interrupted).toBe(true);
      /* The interrupted follow-up settles itself on its first boundary —
         nothing wedges. */
      expect((await next).stopReason).toBe("cancelled");
      /* The drain owns no turn — the interrupt belonged to the follow-up,
         so the queued close (sa-1) must still be delivered. */
      expect(
        events.some(
          (e) =>
            e.type === "subagent.completed" && e.payload.subagentId === "sa-1",
        ),
      ).toBe(true);
      const snap = await snapshot(c, sessionId);
      expect(snap.state).toBe("idle");
      expect(snap.turn).toBeUndefined();
      const res = await promptText(c, sessionId, "follow-up after the stop");
      expect(res.stopReason).toBe("end_turn");
      /* An escaped rejection fires on its own microtask turn — give it a
         flush window before asserting none landed. */
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      off();
      c.close();
    }
  });

  test("AC-2 session.stop inside the drain's sleep: the queued close drops with the closed session — no unhandled rejection", async () => {
    const { unhandled, off } = trackUnhandled();
    const c = conn(2);
    try {
      const { sessionId, events, next } = await armDrain(c);
      const ack = (await c.request("session.stop", { sessionId })) as {
        stopped: boolean;
      };
      expect(ack.stopped).toBe(true);
      /* The stopped turn settles itself inside the closed session. */
      expect((await next).stopReason).toBe("cancelled");
      /* A closed session drops pending closes like the tick drain and
         flushHeldCloses do — sa-1 never completes. */
      expect(
        events.some(
          (e) =>
            e.type === "subagent.completed" && e.payload.subagentId === "sa-1",
        ),
      ).toBe(false);
      const snap = await snapshot(c, sessionId);
      expect(snap.state).toBe("closed");
      expect(snap.turn).toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      off();
      c.close();
    }
  });
});

describe("engine-fake #431: compact replay + bounded log", () => {
  test("a finished turn's deltas replay as one turn.recap", async () => {
    const c = conn();
    const live: { type: string; text?: string; reasoning?: string }[] = [];
    const text: string[] = [];
    const reasoning: string[] = [];
    let turnId = "";
    c.onEvent((e) => {
      live.push(e as never);
      if (e.type === "turn.started") turnId = e.payload.turnId;
      if (e.type === "turn.delta") {
        if (e.payload.stream === "text") text.push(e.payload.delta);
        else reasoning.push(e.payload.delta);
      }
    });
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-fake",
    })) as { sessionId: string };
    await promptText(c, sessionId, "md: table");

    /* Live listeners still see the verbatim delta stream — the recap is
       log-only, minted at turn.completed after the broadcast. */
    expect(live.map((e) => e.type)).toContain("turn.delta");
    expect(live.map((e) => e.type)).not.toContain("turn.recap");

    const since = (await c.request("events.since", {
      sessionId,
      after: 0,
    })) as {
      events: {
        seq: number;
        type: string;
        payload: { turnId?: string; text?: string; reasoning?: string };
      }[];
      truncated: boolean;
      latestSeq: number;
    };
    const turnEvents = since.events.filter((e) => e.payload.turnId === turnId);
    expect(turnEvents.filter((e) => e.type === "turn.delta")).toEqual([]);
    const recaps = turnEvents.filter((e) => e.type === "turn.recap");
    expect(recaps).toHaveLength(1);
    expect(recaps[0].payload.text).toBe(text.join(""));
    expect(recaps[0].payload.reasoning).toBe(reasoning.join(""));
    /* The recap sits at the last delta's seq — no new seq minted, order
       stays monotonic, and the run's tool.started/completed survive. */
    const seqs = since.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(since.truncated).toBe(false);
    c.close();
  });

  test("eventLogCap bounds the log and events.since reports truncation", async () => {
    const c = connectFake(new FakeEngine({ tick: 1, eventLogCap: 12 }));
    const { sessionId } = (await c.request("session.start", {
      agent: "builder",
      cwd: "/tmp/lilos-fake",
    })) as { sessionId: string };
    await promptText(c, sessionId, "md: table");

    const since = (await c.request("events.since", {
      sessionId,
      after: 0,
    })) as {
      events: { seq: number; type: string }[];
      truncated: boolean;
      latestSeq: number;
    };
    expect(since.events.length).toBeLessThanOrEqual(12);
    /* The requested range lost events: `after: 0` can never rebuild the
       early log — the client must refetch state, not patch. */
    expect(since.truncated).toBe(true);
    /* turn.completed is the newest frame — the cap drops from the head,
       so the settled turn's end always survives. */
    expect(since.events.some((e) => e.type === "turn.completed")).toBe(true);

    /* A watermark past the dropped prefix is honest again. */
    const tail = (await c.request("events.since", {
      sessionId,
      after: since.events[0].seq,
    })) as { truncated: boolean };
    expect(tail.truncated).toBe(false);
    c.close();
  });
});
