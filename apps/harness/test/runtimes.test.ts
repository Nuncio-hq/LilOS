import type { AgentDescriptor, EngineEvent } from "@lilos/contracts/engine";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import { externalEngineLauncher } from "../src/engine/launcher";
import { EngineRegistry } from "../src/engine/registry";
import {
  DEFAULT_RUNTIME,
  normalizeRuntime,
  parseSessionRef,
  qualifySessionRef,
  type RuntimeSpec,
} from "../src/engine/runtimes";
import { createAppOps } from "../src/harness/app-ops";
import { createMemoryLogger } from "../src/log";
import {
  mkhome,
  openDmConversation,
  setupWorld,
  type World,
  waitFor,
} from "./helpers";

/**
 * D-#761: several engines at once, each thread on its agent's runtime.
 * Two FakeEngines play `hermes` + `acp:devin` — the fixtures attach
 * conns directly (the production path's registry does the same through
 * its per-runtime supervisors), so routing, qualification, isolation
 * and the hand-off exercise the real bind/dispatch/event code.
 */

const ACP = "acp:devin";

/** Attach a second FakeEngine as a non-default runtime; returns its
    call log, event tap, and a `kill()` that makes later requests fail
    the way a dead engine's socket would. */
function attachRuntime(w: World, runtime: string) {
  const engine = new FakeEngine({ tick: 1 });
  const calls: { method: string; params: unknown }[] = [];
  const raw = connectFake(engine) as unknown as EngineConnection;
  const origRequest = raw.request.bind(raw);
  let dead = false;
  raw.request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    if (dead) return Promise.reject(new Error("engine down"));
    calls.push({ method, params });
    return origRequest<T>(method, params);
  };
  const events: EngineEvent[] = [];
  raw.onEvent((e) => events.push(e));
  w.harness.attachEngine(raw, undefined, runtime);
  return {
    engine,
    conn: raw,
    calls,
    events,
    kill: () => {
      dead = true;
      raw.close();
    },
  };
}

async function send(w: World, channelId: string, text: string) {
  const { conversations } = await w.user.request<{
    conversations: { id: string; channelId: string }[];
  }>("conversations.list", { channelId });
  const conv = conversations.find((c) => c.channelId === channelId);
  if (!conv) {
    await w.user.request("conversations.open", { channelId, text });
    return;
  }
  await w.user.request("messages.post", {
    channelId,
    conversationId: conv.id,
    text,
    authorKind: "user",
  });
}

describe("session refs (D-#761)", () => {
  it("the default runtime keeps bare ids; others qualify", () => {
    expect(qualifySessionRef(DEFAULT_RUNTIME, "s-1")).toBe("s-1");
    expect(qualifySessionRef(ACP, "s-1")).toBe(`${ACP}::s-1`);
    expect(parseSessionRef("s-1")).toEqual({
      runtime: DEFAULT_RUNTIME,
      sessionId: "s-1",
    });
    expect(parseSessionRef(`${ACP}::s-1`)).toEqual({
      runtime: ACP,
      sessionId: "s-1",
    });
    // An engine's own ':' session id survives — split on the first "::".
    expect(parseSessionRef(`${ACP}::a:b`)).toEqual({
      runtime: ACP,
      sessionId: "a:b",
    });
  });

  it("absent/blank/default/hermes all mean the default runtime", () => {
    for (const v of [undefined, null, "", " ", "default", "hermes"]) {
      expect(normalizeRuntime(v)).toBe(DEFAULT_RUNTIME);
    }
    expect(normalizeRuntime(ACP)).toBe(ACP);
  });
});

describe("two runtimes at once (D-#761)", () => {
  it("each employee's turns run on its own engine", async () => {
    const w = await setupWorld({ homeDir: mkhome() });
    const acp = attachRuntime(w, ACP);
    try {
      const { employee: ada, channel: chA } = await openDmConversation(w.user);
      const { employee: dev } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "coder",
        profile: "devin",
        runtime: ACP,
      });
      const { channel: chB } = await w.user.request<{
        channel: { id: string };
      }>("channels.openDm", { employeeId: dev.id });

      await send(w, chA.id, "hello Ada");
      await send(w, chB.id, "hello Devin");

      /* Each engine started exactly one session, with its own local id —
         and each conversation's engineRef points at ITS runtime (the ACP
         child's ref is qualified). */
      await waitFor(() => {
        const a = w.engineCalls.find((c) => c.method === "session.start");
        const b = acp.calls.find((c) => c.method === "session.start");
        return a && b ? { a, b } : undefined;
      }, "session.start on both engines");
      expect(
        acp.calls.filter((c) => c.method === "session.start"),
      ).toHaveLength(1);
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef?: string }[];
        }>("conversations.list", {});
        const convs = conversations.filter((c) => c.engineRef);
        return convs.length === 2 ? convs : undefined;
      }, "both engineRefs");
      const { conversations } = await w.user.request<{
        conversations: {
          id: string;
          channelId: string;
          engineRef?: string;
        }[];
      }>("conversations.list", {});
      const convA = conversations.find((c) => c.channelId === chA.id);
      const convB = conversations.find((c) => c.channelId === chB.id);
      expect(convA?.engineRef).toBeDefined();
      expect(convA?.engineRef).not.toContain("::");
      expect(convB?.engineRef).toMatch(new RegExp(`^${ACP}::`));

      /* And each prompt rode only to the owning engine. */
      expect(acp.calls.filter((c) => c.method === "prompt")).toHaveLength(1);
      expect(
        w.engineCalls.filter((c) => c.method === "prompt").length,
      ).toBeGreaterThanOrEqual(1);
      void ada;
      void dev;
    } finally {
      await w.cleanup();
    }
  }, 20_000);

  it("one engine's crash never touches the other runtime's threads", async () => {
    const w = await setupWorld({ homeDir: mkhome() });
    const acp = attachRuntime(w, ACP);
    try {
      const { channel: chA } = await openDmConversation(w.user);
      const { employee: dev } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "coder",
        runtime: ACP,
      });
      const { channel: chB } = await w.user.request<{
        channel: { id: string };
      }>("channels.openDm", { employeeId: dev.id });
      await send(w, chA.id, "hi Ada");
      await send(w, chB.id, "hi Devin");
      await waitFor(
        () =>
          w.engineCalls.some((c) => c.method === "session.start") &&
          acp.calls.some((c) => c.method === "session.start")
            ? true
            : undefined,
        "both sessions",
      );
      /* Let the default thread's first turn finish — its follow-up then
         prompts instead of queuing behind a still-running lane. */
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: {
            channelId: string;
            finishedSeq: number;
          }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.channelId === chA.id)?.finishedSeq
          ? true
          : undefined;
      }, "default thread's first turn");

      /* Kill the ACP engine: its later requests reject, and the default
         runtime's thread still turns. */
      acp.kill();
      await send(w, chA.id, "still there?");
      await waitFor(
        () =>
          w.engineCalls.filter((c) => c.method === "prompt").length >= 2
            ? true
            : undefined,
        "default runtime still prompting",
      );
      /* The dead runtime's calls fail cleanly — its conversation parks
         without erroring into the other engine's lane. */
      await expect(acp.conn.request("describe", {})).rejects.toThrow(
        /engine down/,
      );
    } finally {
      await w.cleanup();
    }
  }, 20_000);

  it("a task_create hand-off lands the child on the agent's runtime", async () => {
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    const acp = attachRuntime(w, ACP);
    try {
      const { employee: caller, channel: callerChannel } =
        await openDmConversation(w.user);
      const { employee: worker } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "coder",
        runtime: ACP,
      });
      const { conversation: parent } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: callerChannel.id,
        text: "Plan the feature",
        /* tasks.create files the child under the parent's project — a
           folder-less caller can't carry the ticket (D-#844). */
        cwd: homeDir,
      });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; finishedSeq: number }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.id === parent.id)?.finishedSeq
          ? true
          : undefined;
      }, "parent root turn");

      const ops = createAppOps({
        relay: w.harnessRelay,
        runningTurnId: () => undefined,
        log: w.log,
        home: homeDir,
      })("s1", {
        employeeId: caller.id,
        channelId: callerChannel.id,
        conversationId: parent.id,
      });
      if (!ops) throw new Error("no appOps");
      /* The child's DM-channel prompt binds on the Devin employee's
         runtime — session.start lands on the ACP engine, never on the
         default one. */
      const startsBefore = w.engineCalls.filter(
        (c) => c.method === "session.start",
      ).length;
      const r = await ops.taskCreate({
        agent: "Devin",
        prompt: "Sketch the module",
        isolation: "shared",
      });
      expect(r.task.agentId).toBe(worker.id);
      await waitFor(
        () =>
          acp.calls.some((c) => c.method === "session.start")
            ? true
            : undefined,
        "child session.start on acp:devin",
      );
      const childStarts = w.engineCalls.filter(
        (c) => c.method === "session.start",
      ).length;
      expect(childStarts).toBe(startsBefore);
      const { conversations } = await w.user.request<{
        conversations: {
          id: string;
          parentId?: string;
          engineRef?: string;
        }[];
      }>("conversations.list", {});
      const child = conversations.find((c) => c.parentId === parent.id);
      expect(child?.engineRef).toMatch(new RegExp(`^${ACP}::`));
    } finally {
      await w.cleanup();
    }
  }, 30_000);
});

describe("a runtime that cannot start (D-#761 review)", () => {
  /** A world whose acp:devin row can never connect — the harness drives
      the registry exactly as index.ts does. The default runtime stays on
      the fixture's attached FakeEngine (the registry holds only acp). */
  async function failingWorld() {
    const homeDir = mkhome();
    const log = createMemoryLogger();
    const reg = new EngineRegistry(
      [
        {
          id: ACP,
          label: "Devin",
          launcher: () => externalEngineLauncher("mem://acp-dead"),
          seedAgents: [
            { id: "devin", name: "Devin", detail: { isDefault: true } },
          ],
        },
      ],
      {
        connect: () => Promise.reject(new Error("adapter dead")),
        log,
        minBackoffMs: 1,
        maxBackoffMs: 4,
        reconnectAttempts: 1,
        maxConsecutiveCrashes: 2,
        failedRetryCooldownMs: 60_000,
        hooks: {
          onConnection: (runtime, conn, _r, gap) =>
            w.harness.attachEngine(conn, gap, runtime),
          onStateChange: (runtime, state, detail) =>
            w.harness.onEngineStateChange(state, detail, runtime),
        },
      },
    );
    const w = await setupWorld({
      homeDir,
      harnessExtra: { runtimes: reg },
    });
    return { w, reg, log, homeDir };
  }

  it("a parked send ends in a visible failure, then the runtime idles", async () => {
    const { w, reg } = await failingWorld();
    try {
      const { employee: dev } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "coder",
        runtime: ACP,
      });
      const { channel: ch } = await w.user.request<{
        channel: { id: string };
      }>("channels.openDm", { employeeId: dev.id });
      await send(w, ch.id, "hello Devin");
      /* The send parks in `early` while the supervisor's bounded budget
         burns, then surfaces like a failed prompt — note + turnFailure —
         instead of parking forever behind endless retries. */
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: {
            channelId: string;
            turnFailure?: { text: string } | null;
          }[];
        }>("conversations.list", {});
        const c = conversations.find((c) => c.channelId === ch.id);
        return c?.turnFailure ? c : undefined;
      }, "turnFailure on the waiting thread");
      const { messages } = await w.user.request<{
        messages: { authorKind: string; text: string }[];
      }>("messages.list", { channelId: ch.id });
      expect(
        messages.some(
          (m) => m.authorKind === "system" && /engine/i.test(m.text),
        ),
      ).toBe(true);
      /* With the thread settled, nothing needs acp:devin — supervision
         of the dead row stops (the row idles, no restart churn). */
      await waitFor(
        () => (reg.get(ACP)?.state === "idle" ? true : undefined),
        "failed runtime released",
      );
    } finally {
      await reg.stop();
      await w.cleanup();
    }
  }, 30_000);

  it("a task child on a dead runtime wakes its parent as failed", async () => {
    const { w, reg, homeDir } = await failingWorld();
    try {
      const { employee: caller, channel: callerChannel } =
        await openDmConversation(w.user);
      const { employee: worker } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "coder",
        runtime: ACP,
      });
      const { conversation: parent } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: callerChannel.id,
        text: "Plan the feature",
        cwd: homeDir,
      });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; finishedSeq: number }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.id === parent.id)?.finishedSeq
          ? true
          : undefined;
      }, "parent root turn");
      const ops = createAppOps({
        relay: w.harnessRelay,
        runningTurnId: () => undefined,
        log: w.log,
        home: homeDir,
      })("s1", {
        employeeId: caller.id,
        channelId: callerChannel.id,
        conversationId: parent.id,
      });
      if (!ops) throw new Error("no appOps");
      await ops.taskCreate({
        agent: "Devin",
        prompt: "Sketch the module",
        isolation: "shared",
      });
      void worker;
      /* The child's runtime never starts — the parent still hears about
         it as a failed task wake instead of waiting forever. */
      await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: { taskWake?: boolean; text: string }[];
        }>("messages.list", {
          channelId: callerChannel.id,
          conversationId: parent.id,
        });
        return messages.some((m) => m.taskWake && /fail/i.test(m.text))
          ? true
          : undefined;
      }, "failed task wake on the parent");
    } finally {
      await reg.stop();
      await w.cleanup();
    }
  }, 30_000);
});

describe("EngineRegistry (D-#761)", () => {
  const seed: AgentDescriptor = {
    id: "devin",
    name: "Devin",
    detail: { isDefault: true },
  };

  function world(
    opts: {
      failUrls?: Set<string>;
      adapterMissing?: Set<string>;
      failedRetryCooldownMs?: number;
    } = {},
  ) {
    const log = createMemoryLogger();
    const attached: { runtime: string; reconnect: boolean }[] = [];
    const states: { runtime: string; state: string; detail?: string }[] = [];
    const conns = new Map<string, EngineConnection>();
    const specs: RuntimeSpec[] = [
      {
        id: DEFAULT_RUNTIME,
        label: "engine-fake",
        launcher: () => externalEngineLauncher("mem://default"),
      },
      {
        id: ACP,
        label: "Devin",
        launcher: () => externalEngineLauncher("mem://acp"),
        seedAgents: [seed],
        adapterPresent: () => !opts.adapterMissing?.has(ACP),
      },
    ];
    const reg = new EngineRegistry(specs, {
      connect: async (url) => {
        if (opts.failUrls?.has(url)) throw new Error(`${url} refused`);
        const conn = conns.get(url);
        if (conn) return conn;
        const c = connectFake(
          new FakeEngine({ tick: 1 }),
        ) as unknown as EngineConnection;
        conns.set(url, c);
        return c;
      },
      log,
      minBackoffMs: 1,
      maxBackoffMs: 4,
      reconnectAttempts: 1,
      maxConsecutiveCrashes: 2,
      failedRetryCooldownMs: opts.failedRetryCooldownMs ?? 60_000,
      hooks: {
        onConnection: (runtime, _conn, reconnect) =>
          attached.push({ runtime, reconnect }),
        onStateChange: (runtime, state, detail) =>
          states.push({ runtime, state, detail }),
      },
    });
    return { reg, attached, states, conns, log };
  }

  it("boot starts only the default runtime; acp:devin waits for demand", async () => {
    const { reg, attached } = world();
    await reg.start();
    expect(attached.map((a) => a.runtime)).toEqual([DEFAULT_RUNTIME]);
    expect(reg.get(ACP)?.state).toBe("idle");

    const conn = await reg.ensure(ACP);
    expect(conn).toBe(reg.connFor(ACP));
    expect(attached.map((a) => a.runtime)).toEqual([DEFAULT_RUNTIME, ACP]);
    // ensure is idempotent — same conn, no second attach.
    await expect(reg.ensure(ACP)).resolves.toBe(conn);
    expect(attached).toHaveLength(2);
    await reg.stop();
  });

  it("a failing runtime fails alone — the default keeps serving", async () => {
    const { reg, states } = world({ failUrls: new Set(["mem://acp"]) });
    await reg.start();
    await expect(reg.ensure(ACP)).rejects.toThrow(/refused|failed/i);
    await waitFor(
      () =>
        states.some((s) => s.runtime === ACP && s.state === "failed")
          ? true
          : undefined,
      "acp:devin failed",
    );
    expect(
      states.some((s) => s.runtime === DEFAULT_RUNTIME && s.state === "failed"),
    ).toBe(false);
    expect(reg.connFor(DEFAULT_RUNTIME)).toBeDefined();
    await reg.stop();
  });

  it("status rows report availability + lifecycle per runtime", async () => {
    const { reg } = world();
    await reg.probeAvailable({ PATH: "/usr/bin" });
    const idle = reg.statusRows();
    expect(idle.map((r) => r.id)).toEqual([DEFAULT_RUNTIME, ACP]);
    expect(idle[1]?.state).toBeUndefined(); // never started → absent
    await reg.start();
    const rows = reg.statusRows();
    expect(rows[0]?.state).toBeDefined();
    await reg.stop();
  });

  /* A packaged build without lilos-engine-acp must NOT report the
     runtime hirable (real-app review of #859: the row claimed
     `available: true` with the adapter absent). The recipe alone is not
     availability — the adapter has to exist on disk. */
  it("a runtime whose adapter is not in the build reports unavailable", async () => {
    const { reg } = world({ adapterMissing: new Set([ACP]) });
    await reg.probeAvailable({ PATH: "/usr/bin" });
    const row = reg.statusRows().find((r) => r.id === ACP);
    expect(row?.available).toBe(false);
    expect(row?.detail).toMatch(/adapter/i);
    /* And a demand fails plainly instead of spawning a supervisor cycle. */
    await expect(reg.ensure(ACP)).rejects.toThrow(/adapter|not.*build/i);
  });

  /* Real-app review of #859: every ensure() re-drove a fresh
     start→fail cycle (starting→restarting→failed logs thousands of
     times a minute). A failed row answers demands with the recorded
     reason for the cooldown window — only then does a new demand earn
     ONE fresh bounded start cycle. */
  it("a failed runtime rejects demand without re-launching inside the cooldown", async () => {
    const { reg, states } = world({ failUrls: new Set(["mem://acp"]) });
    await reg.start();
    await expect(reg.ensure(ACP)).rejects.toThrow();
    await waitFor(
      () =>
        states.some((s) => s.runtime === ACP && s.state === "failed")
          ? true
          : undefined,
      "acp:devin failed",
    );
    const starts = () =>
      states.filter((s) => s.runtime === ACP && s.state === "starting").length;
    const cycles = starts();
    await expect(reg.ensure(ACP)).rejects.toThrow();
    await expect(reg.ensure(ACP)).rejects.toThrow();
    expect(starts()).toBe(cycles);
    await reg.stop();
  });

  /* Same review: the runtime kept supervising after the only employee
     on it was removed. `release` frees the supervisor of a failed
     non-default row — the row idles until real demand returns. */
  it("release() idles a failed non-default runtime", async () => {
    const { reg } = world({ failUrls: new Set(["mem://acp"]) });
    await reg.start();
    await expect(reg.ensure(ACP)).rejects.toThrow();
    await waitFor(
      () => (reg.get(ACP)?.state === "failed" ? true : undefined),
      "failed",
    );
    await reg.release(ACP);
    expect(reg.get(ACP)?.state).toBe("idle");
    expect(reg.get(ACP)?.supervisor).toBeUndefined();
    await reg.stop();
  });

  /* #859 CI regression: buildSupervisor used to forward every tunable
     unconditionally — an unset option landed as an explicit `undefined`
     and spread over the supervisor's defaults, erasing backoff AND the
     crash budget (NaN retry delay, crashCount >= undefined never true):
     the default engine hot-looped forever instead of reaching `failed`,
     and every engine-status e2e surface stayed "restarting". index.ts
     passes no tunables, so defaults must survive. */
  it("with no tunables the supervisor keeps its own crash budget — failed, not a hot loop", async () => {
    const log = createMemoryLogger();
    let launches = 0;
    const reg = new EngineRegistry(
      [
        {
          id: DEFAULT_RUNTIME,
          label: "engine-fake",
          launcher: () => {
            const l = externalEngineLauncher("mem://dead");
            return {
              ...l,
              start: async () => {
                launches += 1;
                return l.start();
              },
            };
          },
        },
      ],
      {
        connect: () => Promise.reject(new Error("engine down")),
        log,
        hooks: { onConnection: () => {}, onStateChange: () => {} },
      },
    );
    void reg.start().catch(() => {});
    /* A hot loop (defaults erased) shows dozens of launches inside the
       window long before `failed` ever arrives; the real supervisor
       fails after its default budget of 5. */
    const outcome = await Promise.race([
      waitFor(
        () => (reg.get(DEFAULT_RUNTIME)?.state === "failed" ? true : undefined),
        "default runtime failed",
      ).then(() => "failed" as const),
      waitFor(() => (launches > 8 ? true : undefined), "launch hot loop").then(
        () => "looping" as const,
      ),
    ]);
    expect(outcome).toBe("failed");
    expect(launches).toBeLessThanOrEqual(5);

    /* The default runtime keeps main's semantics: demand on a failed row
       re-drives one bounded attempt on the same supervisor — no
       cooldown gate (that gate exists for lazily-started coding
       runtimes, not the engine everyone needs). */
    await expect(reg.ensure(DEFAULT_RUNTIME)).rejects.toThrow();
    expect(launches).toBe(6);
    await reg.stop();
  }, 30_000);

  it("stop rejects parked ensure() waiters", async () => {
    const { reg } = world();
    const p = reg.ensure(DEFAULT_RUNTIME);
    const stop = reg.stop();
    await expect(p).rejects.toThrow(/stopped/);
    await stop;
  });
});
