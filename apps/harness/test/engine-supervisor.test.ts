import type { EngineEvent } from "@lilos/contracts/engine";
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

/** Engine child whose lifetime the test drives. `graceful` models a
    SIGTERMed adapter that drains first (engine/backend close can take
    seconds): kill() is recorded but the exit only lands on die(). */
function fakeProc(
  pid: number,
  opts: { graceful?: boolean } = {},
): {
  proc: EngineProcess;
  die: (code: number | null, signal?: string) => void;
  killCalls: number;
} {
  let die: (code: number | null, signal?: string) => void = () => {};
  const exited = new Promise<EngineExit>((r) => {
    die = (code, signal) => r({ code, signal: signal ?? null });
  });
  const self = {
    killCalls: 0,
    die,
    proc: {
      pid,
      exited,
      kill: () => {
        self.killCalls += 1;
        if (!opts.graceful) die(143);
      },
    },
  };
  return self;
}

/** EngineConnection that never makes real I/O; `drop()` fires onClose and
    `emit()` pushes an engine event to subscribers (a busy adapter's turn
    traffic — the probe's other proof of life, #834). `responder` answers
    every request (default: plain Error = dead air). */
function fakeConn(): EngineConnection & {
  drop: (reason?: string) => void;
  emit: (e: EngineEvent) => void;
  responder: () => Promise<unknown>;
  requestCalls: number;
  closed: boolean;
} {
  let closeCb: ((reason?: string) => void) | undefined;
  const eventFns = new Set<(e: EngineEvent) => void>();
  const conn = {
    requestCalls: 0,
    closed: false,
    responder: (): Promise<unknown> =>
      Promise.reject(new Error("not implemented in test")),
    request: <T>() => {
      conn.requestCalls += 1;
      return conn.responder() as Promise<T>;
    },
    onEvent: (fn: (e: EngineEvent) => void) => {
      eventFns.add(fn);
      return () => eventFns.delete(fn);
    },
    onClose: (fn: (reason?: string) => void) => {
      closeCb = fn;
    },
    close: () => {
      conn.closed = true;
    },
    drop: (reason?: string) => closeCb?.(reason ?? "dropped"),
    emit: (e: EngineEvent) => {
      for (const fn of eventFns) fn(e);
    },
  };
  return conn;
}

/** A minimal live-traffic frame — the adapter pushing turn progress. */
const busyEvent = (seq: number): EngineEvent =>
  ({
    seq,
    sessionId: "s-1",
    type: "session.state",
    payload: { state: "running" },
  }) as EngineEvent;

interface World {
  supervisor: EngineSupervisor;
  procs: ReturnType<typeof fakeProc>[];
  conns: ReturnType<typeof fakeConn>[];
  connections: { conn: EngineConnection; reconnect: boolean }[];
  states: string[];
  details: string[];
  launcher: EngineLauncher;
  launches: number;
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
    /** Per-proc gates launcher.start() awaits first, in launch order. */
    launchGates?: Array<Promise<void> | undefined>;
    /** Procs (by index) whose kill() drains instead of dying at once. */
    gracefulProcs?: number[];
    /** connect() calls after the first conn refused N times (e.g. the
        killed adapter's listener is gone while it still drains). */
    refusedConnects?: number;
  } = {},
): World {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const conns: ReturnType<typeof fakeConn>[] = [];
  const connections: World["connections"] = [];
  const states: string[] = [];
  const details: string[] = [];
  let launches = 0;
  const launcher: EngineLauncher = {
    name: "fake-engine",
    start: () => {
      const gate = extra.launchGates?.[procs.length];
      const make = () => {
        const p = fakeProc(4000 + procs.length, {
          graceful: extra.gracefulProcs?.includes(procs.length),
        });
        procs.push(p);
        return { url: "ws://127.0.0.1:9/ws", process: p.proc };
      };
      launches += 1;
      return gate ? gate.then(make) : Promise.resolve<LaunchedEngine>(make());
    },
  };
  let refused = extra.refusedConnects ?? 0;
  const supervisor = new EngineSupervisor({
    launcher,
    connect: async () => {
      const gate = extra.connectGates?.[conns.length];
      if (gate) await gate;
      /* The initial connect is exempt: refusals model a dead listener —
         there is nothing to refuse the first conn on. */
      if (conns.length > 0 && refused-- > 0) throw new Error("connect refused");
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
  return {
    supervisor,
    procs,
    conns,
    connections,
    states,
    details,
    launcher,
    get launches() {
      return launches;
    },
  };
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

  /* #834: a busy-but-alive Hermes adapter can miss the describe deadline —
     its `describe` used to ride the backend's stalled event loop while turn
     events kept flowing. Event frames are proof of life equal to an answer:
     they reset the dead-air count, so only sustained silence restarts. */
  it("live event traffic keeps a describe-missing adapter alive; silence after it still kills", async () => {
    const w = world({
      probeIntervalMs: 5,
      probeTimeoutMs: 10,
      probeMissesBeforeRestart: 2,
      // describe never answers inside the probe deadline — every probe is
      // dead air on the request path (the fake conn has no request timer,
      // so the rejection stands in for the client's own deadline); only
      // the event stream can prove the adapter is alive.
      responders: [
        () =>
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("dead air")), 50),
          ),
        () => Promise.resolve({}),
      ],
    });
    await w.supervisor.start();
    const c0 = w.conns[0];
    if (!c0) throw new Error("conn missing");

    // Miss 1 lands while the adapter is quiet: the verdict reads restarting.
    for (let i = 0; i < 20 && w.states.at(-1) !== "restarting"; i++)
      await tick();
    expect(w.states.at(-1)).toBe("restarting");
    expect(w.details.at(-1)).toContain("probe timeout");

    // A turn's progress frame proves the adapter's event loop is alive —
    // the dead-air count resets and the dead-air verdict lifts.
    let seq = 0;
    c0.emit(busyEvent(++seq));
    for (let i = 0; i < 20 && w.states.at(-1) !== "running"; i++) await tick();
    expect(w.states.at(-1)).toBe("running");

    // Now hold it busy indefinitely — events flow between probes while
    // describe still never answers. Two consecutive dead-air misses can
    // never accumulate, so the process is never killed.
    const traffic = setInterval(() => c0.emit(busyEvent(++seq)), 4);
    try {
      for (let i = 0; i < 12; i++) await tick();
      expect(w.procs).toHaveLength(1);
      expect(w.conns).toHaveLength(1);
      expect(c0.closed).toBe(false);
    } finally {
      clearInterval(traffic);
    }

    // The moment the traffic stops too, the adapter is genuinely wedged:
    // two dead-air misses land back to back and it is restarted (#482).
    for (let i = 0; i < 30 && w.procs.length < 2; i++) await tick();
    expect(c0.closed).toBe(true);
    expect(w.procs).toHaveLength(2);
    for (let i = 0; i < 10 && w.states.at(-1) !== "running"; i++) await tick();
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

  /* #834 review repro: SIGTERM the adapter — its ws listener dies at once
     (socket drop, reconnects refuse) while the process keeps draining its
     graceful shutdown (engine.close + backend.close, ~seconds under load).
     The relaunch's attachProcess SIGTERMs that drainer; when it finally
     exits code 0 the exit must be read as a superseded generation leaving,
     never as a crash of the fresh engine — the pre-fix handler ran the
     shared exit path against current state (conn closed, crash counted,
     relaunch armed), and the next attachProcess killed the healthy
     adapter: the self-perpetuating "engine exited code 0" loop. */
  it("#834 a killed adapter's late exit does not kill the healthy replacement", async () => {
    const w = world({
      gracefulProcs: [0],
      refusedConnects: 2,
      reconnectAttempts: 2,
      maxConsecutiveCrashes: 3,
    });
    await w.supervisor.start();
    expect(w.states.at(-1)).toBe("running");

    w.conns[0]?.drop("adapter killed");
    for (let i = 0; i < 40 && w.conns.length < 2; i++) await tick();
    expect(w.procs).toHaveLength(2);
    expect(w.procs[0]?.killCalls).toBe(1);
    expect(w.connections.at(-1)?.reconnect).toBe(false);
    expect(w.states.at(-1)).toBe("running");

    // The drained adapter's exit lands now — after the replacement is up.
    w.procs[0]?.die(0);
    for (let i = 0; i < 10; i++) await tick();

    expect(w.procs).toHaveLength(2);
    expect(w.conns[1]?.closed).toBe(false);
    expect(w.states.at(-1)).toBe("running");
    await w.supervisor.stop();
  });

  /* Same race one ordering earlier: the killed adapter's exit lands while
     the replacement's launch is still in flight (before attachProcess).
     That exit is legitimately handled — but the relaunch it arms must be
     consumed by the in-flight start: if it fires after the fresh conn
     published, the next attachProcess kills the healthy adapter anyway. */
  it("#834 an exit landing mid-relaunch arms no restart over the fresh conn", async () => {
    let launchRelease!: () => void;
    const launchGate = new Promise<void>((r) => {
      launchRelease = r;
    });
    const w = world({
      minBackoffMs: 30,
      maxBackoffMs: 60,
      gracefulProcs: [0],
      refusedConnects: 2,
      reconnectAttempts: 2,
      launchGates: [undefined, launchGate],
      maxConsecutiveCrashes: 3,
    });
    await w.supervisor.start();
    expect(w.states.at(-1)).toBe("running");

    w.conns[0]?.drop("adapter killed");
    // Reconnects refuse; the relaunch's start() holds on the gate.
    for (let i = 0; i < 40 && w.launches < 2; i++) await tick();
    expect(w.launches).toBe(2);

    w.procs[0]?.die(0);
    launchRelease();
    for (let i = 0; i < 40 && w.conns.length < 2; i++) await tick();
    expect(w.states.at(-1)).toBe("running");

    for (let i = 0; i < 10; i++) await tick();
    expect(w.launches).toBe(2);
    expect(w.procs).toHaveLength(2);
    expect(w.conns[1]?.closed).toBe(false);
    await w.supervisor.stop();
  });
});

describe("D-#817 plugin refresh restart", () => {
  it("a plugin refresh does not spend the crash budget", async () => {
    const w = world({
      probeIntervalMs: 0,
      maxConsecutiveCrashes: 2,
      stableAfterMs: 60_000,
    });
    await w.supervisor.start();
    expect(w.procs).toHaveLength(1);
    expect(w.states.at(-1)).toBe("running");

    w.supervisor.restartForPluginRefresh();
    for (let i = 0; i < 10 && w.procs.length < 2; i++) await tick();
    expect(w.procs).toHaveLength(2);
    expect(w.details).toContain("lilos plugin refreshed");
    expect(w.supervisor.state.current).toBe("running");

    // A real crash right after must still relaunch. If the refresh had
    // counted, this second fast exit would exhaust the budget of 2.
    w.procs[1]?.die(1);
    for (let i = 0; i < 10 && w.procs.length < 3; i++) await tick();
    expect(w.supervisor.state.current).not.toBe("failed");
    expect(w.procs).toHaveLength(3);
    await w.supervisor.stop();
  });
});
