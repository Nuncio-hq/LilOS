import { readdirSync } from "node:fs";
import type { AgentDescriptor, EngineEvent } from "@lilos/contracts/engine";
import type { AcpLaunchSpec } from "@lilos/engine-acp";
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

  it("a roster call's `runtime` hint routes to that engine, stripped", async () => {
    /* #872: the agent page's describe/update/models.list carry the owning
       runtime id as app→harness metadata — the call must land on that
       engine's conn and the engine must never see the hint. */
    const w = await setupWorld({ homeDir: mkhome() });
    const acp = attachRuntime(w, ACP);
    try {
      /* Seed agents are shared seed objects across FakeEngine instances,
         so an agent created on the ACP side is the clean subject. */
      await w.user.request("agents.create", {
        name: "devin",
        runtime: ACP,
        description: "Cognition's coding agent",
      });
      const described = await w.user.request<{ agent: { id: string } }>(
        "agents.describe",
        { id: "devin", runtime: ACP },
      );
      expect(described.agent.id).toBe("devin");

      await w.user.request("agents.update", {
        id: "devin",
        runtime: ACP,
        description: "edited on the owning runtime",
      });
      const models = await w.user.request<{ models: { id: string }[] }>(
        "models.list",
        { runtime: ACP },
      );
      expect(models.models.length).toBeGreaterThan(0);

      const landed = acp.calls.filter(
        (c) =>
          c.method === "agents.create" ||
          c.method === "agents.describe" ||
          c.method === "agents.update" ||
          c.method === "models.list",
      );
      expect(landed.map((c) => c.method).sort()).toEqual([
        "agents.create",
        "agents.describe",
        "agents.update",
        "models.list",
      ]);
      for (const c of landed) {
        expect(c.params).not.toHaveProperty("runtime");
      }
      expect(
        w.engineCalls.filter(
          (c) =>
            c.method === "agents.create" ||
            c.method === "agents.describe" ||
            c.method === "agents.update" ||
            c.method === "models.list",
        ),
      ).toHaveLength(0);

      /* And the write stayed on ACP — the default engine never heard of
         the `devin` profile. */
      await expect(
        w.user.request("agents.describe", { id: "devin" }),
      ).rejects.toThrow(/no agent devin/);
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

  /* #872: the hand-off's model is the CHILD runtime's business — an
     explicit name is checked against its catalog (a cross-runtime pick
     rejects), a display name resolves to the catalog's own id/provider,
     and no pick at all starts on the child employee's stored default. */
  it("task_create resolves the model on the child's runtime catalog", async () => {
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    const acp = attachRuntime(w, ACP);
    /* The child's engine lists only SWE-2 — the parent's Opus must reject. */
    const orig = acp.conn.request.bind(acp.conn);
    acp.conn.request = <T = unknown>(
      method: string,
      params?: unknown,
    ): Promise<T> =>
      method === "models.list"
        ? (Promise.resolve({
            models: [{ id: "swe-2", name: "SWE-2", provider: "cognition" }],
            default: "swe-2",
            defaultProvider: "cognition",
          }) as Promise<T>)
        : orig<T>(method, params);
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
        checkTaskModel: (employee, model, provider) =>
          w.harness.checkTaskModel(employee, model, provider),
      })("s1", {
        employeeId: caller.id,
        channelId: callerChannel.id,
        conversationId: parent.id,
      });
      if (!ops) throw new Error("no appOps");

      // A name only the parent's engine knows rejects, loudly.
      await expect(
        ops.taskCreate({
          agent: "Devin",
          prompt: "x",
          isolation: "shared",
          model: "opus-5-5",
        }),
      ).rejects.toThrow(/isn't one of Devin's models/);

      // The child's own display name resolves to its catalog id + provider.
      const r = await ops.taskCreate({
        agent: "Devin",
        prompt: "Sketch the module",
        isolation: "shared",
        model: "SWE-2",
      });
      const { conversations } = await w.user.request<{
        conversations: {
          id: string;
          parentId?: string;
          model?: string;
          provider?: string;
        }[];
      }>("conversations.list", {});
      const child = conversations.find((c) => c.id === r.task.threadId);
      expect(child?.model).toBe("swe-2");
      expect(child?.provider).toBe("cognition");

      /* No pick at all: the child employee's stored default stamps (the
         relay's own #872 fallback — the parent's pick would be wrong). */
      await w.user.request("employees.update", {
        id: worker.id,
        model: "swe-2",
      });
      const r2 = await ops.taskCreate({
        agent: "Devin",
        prompt: "Second task",
        isolation: "shared",
      });
      const { conversations: after } = await w.user.request<{
        conversations: { id: string; model?: string }[];
      }>("conversations.list", {});
      expect(after.find((c) => c.id === r2.task.threadId)?.model).toBe("swe-2");
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
      acpSpec?: AcpLaunchSpec;
      launched?: string[];
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
        launcher: () => {
          opts.launched?.push(ACP);
          return externalEngineLauncher("mem://acp");
        },
        seedAgents: [seed],
        adapterPresent: () => !opts.adapterMissing?.has(ACP),
        ...(opts.acpSpec ? { acpSpec: opts.acpSpec } : {}),
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

  /* r6: the adapter's npm install runs in the HARNESS before the engine
     child launches — serve.ts bounded its own resolve+verify inside the
     launcher's 60s startup, so a cold install there could only ever
     time out. A resolve that cannot succeed fails `ensure` plainly and
     NEVER spawns the engine; a resolvable one launches as before. */
  it("ensure provisions the acp adapter before launching — a failed resolve never spawns", async () => {
    const launched: string[] = [];
    /* The failed install must not touch the real ~/.lilos/acp. */
    const cache = mkhome();
    const prev = process.env.LILOS_ACP_CACHE;
    process.env.LILOS_ACP_CACHE = cache;
    const { reg } = world({
      launched,
      acpSpec: {
        id: "devin",
        command: ["lilos-definitely-not-on-path-acp"],
        provision: {
          npm: {
            package: "x",
            version: "file:/nonexistent-pkg",
            bin: "b",
          },
        },
      },
    });
    await reg.start();
    try {
      await reg.start();
      await expect(reg.ensure(ACP)).rejects.toThrow();
      expect(launched).toEqual([]);
      /* Second demand inside the cooldown also does not launch — the
         failed verdict is served, not another install attempt. */
      await expect(reg.ensure(ACP)).rejects.toThrow();
      expect(launched).toEqual([]);
    } finally {
      await reg.stop();
      if (prev === undefined) delete process.env.LILOS_ACP_CACHE;
      else process.env.LILOS_ACP_CACHE = prev;
    }
  });

  /* r10: the boot probe must NEVER provision — it runs once per harness
     boot for every catalog row, and under e2e each stack's scratch HOME
     made that one npm tree per stack (~100/shard → the EDQUOT run).
     Unprovisioned reports unavailable with the reason; the cache stays
     empty. Provisioning belongs to the first real launch (ensure). */
  it("probeAvailable never provisions — an unprovisioned row reports unavailable", async () => {
    const cache = mkhome();
    const prev = process.env.LILOS_ACP_CACHE;
    process.env.LILOS_ACP_CACHE = cache;
    const { reg } = world({
      acpSpec: {
        id: "devin",
        command: ["lilos-definitely-not-on-path-acp"],
        provision: {
          npm: {
            package: "x",
            version: "file:/nonexistent-pkg",
            bin: "b",
          },
        },
      },
    });
    try {
      await reg.probeAvailable();
      const row = reg.statusRows().find((r) => r.id === ACP);
      expect(row?.available).toBe(false);
      expect(row?.detail).toContain("is not installed");
      expect(readdirSync(cache).filter((d) => !d.startsWith("."))).toEqual([]);
    } finally {
      await reg.stop();
      if (prev === undefined) delete process.env.LILOS_ACP_CACHE;
      else process.env.LILOS_ACP_CACHE = prev;
    }
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
    /* #872: inside the cooldown the reject carries the registry's recorded
       reason — "mem://acp refused" — never a bare "engine failed". */
    await expect(reg.ensure(ACP)).rejects.toThrow(/refused/i);
    await expect(reg.ensure(ACP)).rejects.toThrow(/refused/i);
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
