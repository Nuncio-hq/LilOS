import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client.js";
import { EngineRpcError } from "../src/engine/client.js";
import type {
  EngineExit,
  EngineLauncher,
  EngineProcess,
  LaunchedEngine,
} from "../src/engine/launcher.js";
import { FatalEngineStart } from "../src/engine/launcher.js";
import { EngineSupervisor } from "../src/engine/supervisor.js";
import { createMemoryLogger } from "../src/log.js";

/** Engine child whose lifetime the test drives. */
function fakeProc(pid: number): {
  proc: EngineProcess;
  die: (code: number | null, signal?: string) => void;
} {
  let die: (code: number | null, signal?: string) => void = () => {};
  const exited = new Promise<EngineExit>((r) => {
    die = (code, signal) => r({ code, signal: signal ?? null });
  });
  return {
    proc: { pid, exited, kill: () => die(143) },
    die,
  };
}

/** EngineConnection that never makes real I/O; `drop()` fires onClose.
    `responder` answers every request (default: plain Error = dead air). */
function fakeConn(): EngineConnection & {
  drop: (reason?: string) => void;
  responder: () => Promise<unknown>;
  requestCalls: number;
  closed: boolean;
} {
  let closeCb: ((reason?: string) => void) | undefined;
  const conn = {
    requestCalls: 0,
    closed: false,
    responder: (): Promise<unknown> =>
      Promise.reject(new Error("not implemented in test")),
    request: <T>() => {
      conn.requestCalls += 1;
      return conn.responder() as Promise<T>;
    },
    onEvent: () => () => {},
    onClose: (fn: (reason?: string) => void) => {
      closeCb = fn;
    },
    close: () => {
      conn.closed = true;
    },
    drop: (reason?: string) => closeCb?.(reason ?? "dropped"),
  };
  return conn;
}

interface World {
  supervisor: EngineSupervisor;
  procs: ReturnType<typeof fakeProc>[];
  conns: ReturnType<typeof fakeConn>[];
  connections: { conn: EngineConnection; reconnect: boolean }[];
  states: string[];
  details: string[];
  launcher: EngineLauncher;
}

function world(
  extra: {
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stableAfterMs?: number;
    reconnectAttempts?: number;
    maxConsecutiveCrashes?: number;
    probeIntervalMs?: number;
    probeTimeoutMs?: number;
    probeMissesBeforeRestart?: number;
    /** Per-conn responder overrides, in connect() order. */
    responders?: Array<(() => Promise<unknown>) | undefined>;
    /** Per-conn gates connect() must await first, in connect() order. */
    connectGates?: Array<Promise<void> | undefined>;
  } = {},
): World {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const conns: ReturnType<typeof fakeConn>[] = [];
  const connections: World["connections"] = [];
  const states: string[] = [];
  const details: string[] = [];
  const launcher: EngineLauncher = {
    name: "fake-engine",
    start: () => {
      const p = fakeProc(4000 + procs.length);
      procs.push(p);
      return Promise.resolve<LaunchedEngine>({
        url: "ws://127.0.0.1:9/ws",
        process: p.proc,
      });
    },
  };
  const supervisor = new EngineSupervisor({
    launcher,
    connect: async () => {
      const gate = extra.connectGates?.[conns.length];
      if (gate) await gate;
      const c = fakeConn();
      const responder = extra.responders?.[conns.length];
      if (responder) c.responder = responder;
      conns.push(c);
      return c;
    },
    onConnection: (conn, reconnect) => connections.push({ conn, reconnect }),
    onState: (state, detail) => {
      states.push(state);
      if (detail !== undefined) details.push(detail);
    },
    log: createMemoryLogger(),
    minBackoffMs: 1,
    maxBackoffMs: 4,
    reconnectAttempts: 2,
    maxConsecutiveCrashes: 3,
    stableAfterMs: 60_000,
    ...extra,
  });
  return { supervisor, procs, conns, connections, states, details, launcher };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("AC-5 engine supervision", () => {
  it("restarts the engine after a crash and reports reconnect", async () => {
    const w = world();
    await w.supervisor.start();
    expect(w.states).toContain("running");
    expect(w.procs).toHaveLength(1);

    w.procs[0]?.die(1);
    await tick();

    expect(w.launcher.name).toBe("fake-engine");
    expect(w.procs.length).toBe(2);
    expect(w.states).toContain("restarting");
    // Fresh process → harness gets a non-reconnect connection and re-attaches
    // sessions from the engine's store.
    expect(w.connections.at(-1)?.reconnect).toBe(false);
    await w.supervisor.stop();
  });

  it("reconnects the same endpoint when only the socket drops", async () => {
    const w = world();
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);

    w.conns[0]?.drop("idle timeout");
    await tick();

    // Process never died: no relaunch, just a fresh connection.
    expect(w.procs).toHaveLength(1);
    expect(w.conns).toHaveLength(2);
    expect(w.connections.at(-1)?.reconnect).toBe(true);
    await w.supervisor.stop();
  });

  it("gives up with state failed after the crash budget", async () => {
    const w = world({ maxConsecutiveCrashes: 2 });
    await w.supervisor.start();
    w.procs[0]?.die(1);
    await tick();
    expect(w.procs).toHaveLength(2);

    w.procs[1]?.die(1);
    await tick();

    expect(w.states.at(-1)).toBe("failed");
    expect(w.procs).toHaveLength(2); // no further relaunch
    await w.supervisor.stop();
  });

  it("AC-4 reconnects the same endpoint immediately on wake (no waiting for TCP timeout)", async () => {
    const w = world();
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);
    expect(w.conns).toHaveLength(1);

    w.supervisor.notifyWake();
    await tick();

    // Socket presumed dead after sleep: closed and reconnected to the same
    // engine URL without relaunching the still-alive process.
    expect(w.procs).toHaveLength(1);
    expect(w.conns).toHaveLength(2);
    expect(w.connections.at(-1)?.reconnect).toBe(true);
    await w.supervisor.stop();
  });

  it("AC-5b a reconnect that resolves while the process died does not resurrect a dead engine", async () => {
    // kill -9 ordering: the socket drop and the proc exit race. If the
    // in-flight reconnect's connect() resolves after the proc exit landed,
    // that conn belongs to a dead process — it must be closed, and the
    // relaunch path must own recovery (never `running` on a corpse).
    const w = world({ maxConsecutiveCrashes: 2, reconnectAttempts: 3 });
    const deferred: Array<() => void> = [];
    const supervisor = new EngineSupervisor({
      launcher: w.launcher,
      connect: () =>
        new Promise<EngineConnection>((resolve) => {
          deferred.push(() => {
            const c = fakeConn();
            w.conns.push(c);
            resolve(c);
          });
        }),
      onConnection: (conn, reconnect) =>
        w.connections.push({ conn, reconnect }),
      onState: (state) => w.states.push(state),
      log: createMemoryLogger(),
      minBackoffMs: 1,
      maxBackoffMs: 4,
      maxConsecutiveCrashes: 2,
      stableAfterMs: 60_000,
    });
    const flushConnects = async () => {
      for (let i = 0; i < 50 && deferred.length === 0; i++)
        await new Promise((r) => setTimeout(r, 1));
      for (const r of deferred.splice(0)) r();
    };
    const started = supervisor.start();
    await flushConnects();
    await started;
    expect(supervisor.state.current).toBe("running");

    // Proc dies and socket drops at the same instant; reconnect's connect()
    // resolves AFTER the exit landed.
    w.conns[0]?.drop();
    w.procs[0]?.die(1);
    await flushConnects(); // stale reconnect "succeeds" late
    await tick();
    await tick();

    // The dead-proc conn was closed, not published; relaunch (crashCount 1)
    // owns recovery and lands a live second engine.
    await flushConnects(); // relaunch's connect resolves
    await tick();
    expect(w.procs).toHaveLength(2);
    expect(supervisor.state.current).toBe("running");
    // Exactly two conns ever published: initial + relaunch. The stale
    // reconnect conn was dropped — it never reaches onConnection.
    expect(w.connections).toHaveLength(2);
    expect(w.connections.map((c) => c.reconnect)).toEqual([false, false]);
    await supervisor.stop();
  });

  it("does not restart after stop()", async () => {
    const w = world();
    await w.supervisor.start();
    await w.supervisor.stop();

    w.procs[0]?.die(0);
    await tick();
    expect(w.procs).toHaveLength(1);
    expect(w.states.at(-1)).toBe("stopped");
  });
});

describe("AC-2 (#95) exit reasons carry the signal", () => {
  it("a SIGKILLed engine child reads 'killed by SIGKILL' in restart and failed details", async () => {
    const w = world({ maxConsecutiveCrashes: 2 });
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);

    w.procs[0]?.die(null, "SIGKILL");
    await tick();
    // The restart detail names the signal — the relaunch may already be
    // running by the time we read, so check the emitted history, not the tail.
    expect(w.details.join("\n")).toContain("killed by SIGKILL");
    expect(w.details.join("\n")).not.toContain("code null");

    w.procs[1]?.die(null, "SIGKILL");
    await tick();
    expect(w.states.at(-1)).toBe("failed");
    expect(w.details.at(-1)).toContain("killed by SIGKILL");
    await w.supervisor.stop();
  });
});

describe("AC-1 (#95) a fatal start error stops retries immediately", () => {
  it("a launcher that rejects with FatalEngineStart lands failed without restarting", async () => {
    const states: string[] = [];
    const details: string[] = [];
    let launches = 0;
    const supervisor = new EngineSupervisor({
      launcher: {
        name: "hermes",
        start: () => {
          launches += 1;
          return Promise.reject(
            new FatalEngineStart(
              "Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run `hermes update`.",
            ),
          );
        },
      },
      connect: () => Promise.reject(new Error("unreachable")),
      onConnection: () => {},
      onState: (state, detail) => {
        states.push(state);
        if (detail !== undefined) details.push(detail);
      },
      log: createMemoryLogger(),
      minBackoffMs: 1,
      maxBackoffMs: 4,
    });
    await supervisor.start();
    expect(launches).toBe(1); // never retried — it won't fix itself
    expect(states).toEqual(["starting", "failed"]);
    expect(details.at(-1)).toContain("Hermes 0.20.2 is too old");
    await supervisor.stop();
  });
});

/* #482: the liveness probe distinguishes "adapter dead" (dead air) from
   "adapter alive, backend down" (any answered frame, coded or healthy).
   Dead air restarts the launched process; coded frames reset the miss
   count and mirror the backend state without touching the process. */
describe("#482 engine liveness probe", () => {
  it("dead-air probes kill the launched adapter and relaunch it", async () => {
    const w = world({
      probeIntervalMs: 5,
      probeTimeoutMs: 20,
      probeMissesBeforeRestart: 2,
      // conn[0] wedges (dead air); the relaunched engine answers healthy.
      responders: [undefined, () => Promise.resolve({})],
    });
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);
    expect(w.states.at(-1)).toBe("running");

    for (let i = 0; i < 20 && w.procs.length < 2; i++) await tick();

    // The wedged conn was closed and the launched process killed — the
    // exit handler owns the relaunch, so the new engine attaches fresh
    // (not as a reconnect on the same socket).
    expect(w.conns[0]?.closed).toBe(true);
    expect(w.procs).toHaveLength(2);
    expect(w.connections.at(-1)?.reconnect).toBe(false);
    for (let i = 0; i < 10 && w.states.at(-1) !== "running"; i++) await tick();
    expect(w.states.at(-1)).toBe("running");
    await w.supervisor.stop();
  });

  it("a BACKEND_DOWN answer keeps the adapter alive and mirrors restarting", async () => {
    const w = world({
      probeIntervalMs: 5,
      probeTimeoutMs: 20,
      probeMissesBeforeRestart: 2,
      responders: [
        () =>
          Promise.reject(
            new EngineRpcError(-32006, "hermes backend is down (socket)"),
          ),
      ],
    });
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);

    // Many intervals pass — the coded frame proves the adapter answers,
    // so no miss ever accumulates and the process is never killed.
    for (let i = 0; i < 8; i++) await tick();
    expect(w.procs).toHaveLength(1);
    expect(w.conns).toHaveLength(1);
    expect(w.states.at(-1)).toBe("restarting");
    expect(w.details.at(-1)).toContain("backend is down");

    // Backend heals on the same adapter: the next healthy describe
    // flips host state back to running.
    const c0 = w.conns[0];
    if (!c0) throw new Error("conn missing");
    c0.responder = () => Promise.resolve({});
    for (let i = 0; i < 10 && w.states.at(-1) !== "running"; i++) await tick();
    expect(w.states.at(-1)).toBe("running");
    expect(w.procs).toHaveLength(1);
    await w.supervisor.stop();
  });

  it("a process exit retires the conn and stops the probe on it", async () => {
    const w = world({
      probeIntervalMs: 5,
      probeTimeoutMs: 20,
      probeMissesBeforeRestart: 2,
      responders: [() => Promise.resolve({}), () => Promise.resolve({})],
    });
    await w.supervisor.start();
    await tick();
    expect(w.conns[0]?.requestCalls).toBeGreaterThan(0); // probe armed

    w.procs[0]?.die(1);
    await tick();

    // The dead process's conn is closed and the probe no longer ticks
    // it — before this fix the stranded probe kept "missing" on a socket
    // that could never answer and double-drove the restart paths.
    expect(w.conns[0]?.closed).toBe(true);
    const calls = w.conns[0]?.requestCalls;
    await tick();
    await tick();
    expect(w.conns[0]?.requestCalls).toBe(calls);
    // The relaunch still lands: one fresh process, one fresh conn.
    for (let i = 0; i < 10 && w.procs.length < 2; i++) await tick();
    expect(w.procs).toHaveLength(2);
    expect(w.connections.at(-1)?.reconnect).toBe(false);
    await w.supervisor.stop();
  });

  it("a socket drop retires the conn and stops the probe during reconnect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = world({
      probeIntervalMs: 5,
      probeTimeoutMs: 20,
      probeMissesBeforeRestart: 2,
      responders: [() => Promise.resolve({}), () => Promise.resolve({})],
      connectGates: [undefined, gate],
    });
    await w.supervisor.start();
    await tick();
    const calls = w.conns[0]?.requestCalls;
    expect(calls).toBeGreaterThan(0); // probe ticking while running

    /* The conn's own socket drops with reconnect's connect() held on the
       gate. A probe still armed on the dead socket would miss twice and
       kill the healthy adapter mid-reconnect — the drop must stop it. */
    const c0 = w.conns[0];
    if (!c0) throw new Error("conn missing");
    c0.responder = () => Promise.reject(new Error("dead air"));
    c0.drop("net drop");
    await tick();
    await tick();

    expect(c0.requestCalls).toBe(calls);
    expect(w.procs).toHaveLength(1); // adapter never killed for a socket drop

    release();
    for (let i = 0; i < 10 && w.conns.length < 2; i++) await tick();
    expect(w.procs).toHaveLength(1);
    expect(w.connections.at(-1)?.reconnect).toBe(true);
    expect(w.states.at(-1)).toBe("running");
    await w.supervisor.stop();
  });

  it("ensureRunning does not double-start while a relaunch timer is armed", async () => {
    const w = world({ minBackoffMs: 200, maxBackoffMs: 200 });
    await w.supervisor.start();
    w.procs[0]?.die(1);
    await tick(); // exit handled, relaunchAfter armed (state restarting)
    expect(w.states.at(-1)).toBe("restarting");

    w.supervisor.ensureRunning();
    await tick();

    // The armed relaunch owns recovery — a demand poke that stacked a
    // second start() on top would already show a third launcher call.
    expect(w.procs).toHaveLength(1);
    for (let i = 0; i < 20 && w.procs.length < 2; i++) await tick();
    expect(w.procs).toHaveLength(2);
    expect(w.states.at(-1)).toBe("running");
    await w.supervisor.stop();
  });
});
