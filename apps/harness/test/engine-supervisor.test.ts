import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client.js";
import type {
  EngineLauncher,
  EngineProcess,
  LaunchedEngine,
} from "../src/engine/launcher.js";
import { EngineSupervisor } from "../src/engine/supervisor.js";
import { createMemoryLogger } from "../src/log.js";

/** Engine child whose lifetime the test drives. */
function fakeProc(pid: number): {
  proc: EngineProcess;
  die: (code: number | null) => void;
} {
  let die: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    die = r;
  });
  return {
    proc: { pid, exited, kill: () => die(143) },
    die,
  };
}

/** EngineConnection that never makes real I/O; `drop()` fires onClose. */
function fakeConn(): EngineConnection & { drop: (reason?: string) => void } {
  let closeCb: ((reason?: string) => void) | undefined;
  return {
    request: () => Promise.reject(new Error("not implemented in test")),
    onEvent: () => () => {},
    onClose: (fn) => {
      closeCb = fn;
    },
    close: () => {},
    drop: (reason) => closeCb?.(reason ?? "dropped"),
  };
}

interface World {
  supervisor: EngineSupervisor;
  procs: ReturnType<typeof fakeProc>[];
  conns: ReturnType<typeof fakeConn>[];
  connections: { conn: EngineConnection; reconnect: boolean }[];
  states: string[];
  launcher: EngineLauncher;
}

function world(
  extra: {
    minBackoffMs?: number;
    maxBackoffMs?: number;
    stableAfterMs?: number;
    reconnectAttempts?: number;
    maxConsecutiveCrashes?: number;
  } = {},
): World {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const conns: ReturnType<typeof fakeConn>[] = [];
  const connections: World["connections"] = [];
  const states: string[] = [];
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
    connect: () => {
      const c = fakeConn();
      conns.push(c);
      return Promise.resolve(c);
    },
    onConnection: (conn, reconnect) => connections.push({ conn, reconnect }),
    onState: (state) => states.push(state),
    log: createMemoryLogger(),
    minBackoffMs: 1,
    maxBackoffMs: 4,
    reconnectAttempts: 2,
    maxConsecutiveCrashes: 3,
    stableAfterMs: 60_000,
    ...extra,
  });
  return { supervisor, procs, conns, connections, states, launcher };
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
