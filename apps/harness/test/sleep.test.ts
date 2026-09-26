import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../src/log.js";
import {
  createCaffeinateGuard,
  type SleepGuard,
} from "../src/sleep.js";

type SpawnedArgs = { command: string; argv: string[] };

/** Minimal ChildProcess stand-in recording argv and kills. */
function fakeSpawn(): {
  spawn: (command: string, argv: string[]) => unknown;
  spawned: (SpawnedArgs & {
    killed: boolean;
    emit: (event: "exit" | "error", arg?: unknown) => void;
  })[];
} {
  const spawned: (SpawnedArgs & {
    killed: boolean;
    emit: (e: "exit" | "error", arg?: unknown) => void;
  })[] = [];
  const spawn = (command: string, argv: string[]) => {
    const handlers = new Map<string, ((arg?: unknown) => void)[]>();
    const child = {
      command,
      argv,
      killed: false,
      kill() {
        child.killed = true;
        child.emit("exit", null);
      },
      unref() {},
      on(event: string, cb: (arg?: unknown) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      },
      emit(event: "exit" | "error", arg?: unknown) {
        for (const cb of handlers.get(event) ?? []) cb(arg);
      },
    };
    spawned.push(child);
    return child;
  };
  return { spawn: spawn as never, spawned };
}

describe("AC-3 keep-awake (idle-sleep assertion)", () => {
  const log = createMemoryLogger();

  it("holds caffeinate while a turn runs and releases at idle", () => {
    const { spawn, spawned } = fakeSpawn();
    const guard: SleepGuard = createCaffeinateGuard(log, { spawn });
    expect(guard.held).toBe(false);

    guard.acquire();
    expect(guard.held).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toBe("caffeinate");
    expect(spawned[0]!.argv).toContain("-i");

    guard.release();
    expect(guard.held).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
  });

  it("shares one assertion across overlapping turns", () => {
    const { spawn, spawned } = fakeSpawn();
    const guard = createCaffeinateGuard(log, { spawn });
    guard.acquire(); // turn A
    guard.acquire(); // turn B
    expect(spawned).toHaveLength(1);

    guard.release(); // A ends, B still running
    expect(guard.held).toBe(true);
    expect(spawned[0]!.killed).toBe(false);

    guard.release(); // B ends
    expect(guard.held).toBe(false);
    expect(spawned[0]!.killed).toBe(true);
  });

  it("dies with the harness so a crashed harness cannot wedge sleep (-w)", () => {
    const { spawn, spawned } = fakeSpawn();
    const guard = createCaffeinateGuard(log, { spawn });
    guard.acquire();
    const wIndex = spawned[0]!.argv.indexOf("-w");
    expect(wIndex).toBeGreaterThan(-1);
    expect(spawned[0]!.argv[wIndex + 1]).toBe(String(process.pid));
    guard.release();
  });

  it("re-asserts when caffeinate dies mid-turn", () => {
    const { spawn, spawned } = fakeSpawn();
    const guard = createCaffeinateGuard(log, { spawn });
    guard.acquire();
    spawned[0]!.emit("exit", 1); // caffeinate crashed, turn still running
    expect(guard.held).toBe(true);
    expect(spawned).toHaveLength(2);
    guard.release();
  });
});
