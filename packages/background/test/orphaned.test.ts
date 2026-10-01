import { describe, expect, it } from "vitest";
import { ManualClock, watchOrphaned } from "../src/index.js";

/* #347: the watchdog that exits a dev/test process once the tree that
   spawned it is gone — our own reparent, or our parent getting reparented
   because the real owner (test worker, shell, `bun run` caller) died. */

function rig(opts: {
  ppid: () => number;
  parentOf: (pid: number) => number | null;
}) {
  const clock = new ManualClock();
  const reasons: string[] = [];
  const watch = watchOrphaned({
    clock,
    intervalMs: 500,
    ppid: opts.ppid,
    parentOf: opts.parentOf,
    onOrphaned: (r) => reasons.push(r),
  });
  return { clock, reasons, watch };
}

describe("watchOrphaned (#347)", () => {
  it("stays quiet while parentage is stable", () => {
    const { clock, reasons } = rig({
      ppid: () => 42,
      parentOf: (p) => (p === 42 ? 100 : null),
    });
    clock.advance(10_000);
    expect(reasons).toEqual([]);
  });

  it("fires when we are reparented (parent died)", () => {
    let ppid = 42;
    const { clock, reasons } = rig({
      ppid: () => ppid,
      parentOf: (p) => (p === 42 ? 100 : null),
    });
    clock.advance(500);
    expect(reasons).toEqual([]);
    ppid = 1; // kernel reparented us to launchd
    clock.advance(500);
    expect(reasons).toEqual(["reparented (was 42)"]);
  });

  it("fires when our still-alive parent gets reparented (owner died)", () => {
    let grandparent = 100;
    const { clock, reasons } = rig({
      ppid: () => 42,
      parentOf: (p) => (p === 42 ? grandparent : null),
    });
    clock.advance(500);
    expect(reasons).toEqual([]);
    grandparent = 1; // the `bun run` shim's owner died; shim reparented
    clock.advance(500);
    expect(reasons).toEqual(["parent reparented (grandparent was 100)"]);
  });

  it("fires when the parent pid vanishes (reparent not landed yet)", () => {
    let parentPpid: number | null = 100;
    const { clock, reasons } = rig({
      ppid: () => 42,
      parentOf: (p) => (p === 42 ? parentPpid : null),
    });
    clock.advance(500);
    parentPpid = null;
    clock.advance(500);
    expect(reasons).toEqual(["parent reparented (grandparent was 100)"]);
  });

  it("never fires under launchd (ppid 1 from the start)", () => {
    const { clock, reasons } = rig({
      ppid: () => 1,
      parentOf: () => 0,
    });
    clock.advance(60_000);
    expect(reasons).toEqual([]);
  });

  it("checks only ppid when the grandparent baseline is unavailable", () => {
    let ppid = 42;
    const { clock, reasons } = rig({
      ppid: () => ppid,
      parentOf: () => null, // `ps` can't see anything
    });
    clock.advance(5_000);
    expect(reasons).toEqual([]);
    ppid = 1;
    clock.advance(500);
    expect(reasons).toEqual(["reparented (was 42)"]);
  });

  it("fires once and stops ticking", () => {
    let ppid = 42;
    const { clock, reasons } = rig({
      ppid: () => ppid,
      parentOf: () => 100,
    });
    ppid = 1;
    clock.advance(60_000);
    expect(reasons).toHaveLength(1);
  });

  it("stop() silences it", () => {
    let ppid = 42;
    const { clock, reasons, watch } = rig({
      ppid: () => ppid,
      parentOf: () => 100,
    });
    watch.stop();
    ppid = 1;
    clock.advance(5_000);
    expect(reasons).toEqual([]);
  });
});
