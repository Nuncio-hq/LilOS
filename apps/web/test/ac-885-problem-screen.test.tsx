// @vitest-environment happy-dom
/* Issue #885 — the first-run problem screen renders the plain mapping, not
   the status rules' raw words. These tests feed the REAL chain — wire
   rows through `toStatusComponents`, mapped by `relayOf`/`engineOf`/
   `harnessOf` the same way `settings-data` does — so a rule that names
   "relay" or "harness" cannot slip past the plain copy. */

import { toStatusComponents } from "@lilos/client-runtime";
import { EngineProblem, firstRunProblem, type V3Data } from "@lilos/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  engineOf,
  harnessDownStreak,
  harnessOf,
  relayOf,
  startGate,
} from "../src/v3/settings-map";

const data = (settings: Partial<V3Data["settings"]>): V3Data =>
  ({ setUp: false, settings }) as unknown as V3Data;

const problem = (d: V3Data) =>
  render(<EngineProblem data={d} act={{} as never} />).container.querySelector(
    "[data-first-run-problem]",
  );

afterEach(cleanup);

describe("the first-run problem screen says it plainly (#885)", () => {
  test("an unreachable relay maps to the background-service copy, raw stays for See status", () => {
    // The real synthesized rows for a dead socket: relay down, the rest
    // blocked waiting on it.
    const rows = toStatusComponents({ connection: "closed" });
    const relay = relayOf(rows);
    // The rule output really does name the part — proving the mapping
    // (not a friendly reason) is what reaches the screen.
    expect(relay.problem).toMatch(/relay/i);
    const d = data({
      engine: engineOf(rows, undefined),
      harness: harnessOf(rows),
      relay,
    });
    expect(firstRunProblem(d)).toBe(true);
    const el = problem(d);
    expect(el?.textContent).toMatch(/background service isn't running/i);
    expect(el?.textContent).not.toMatch(/\brelay\b/i);
    expect(el?.textContent).not.toMatch(/\bharness\b/i);
  });

  test("a dead-relay reconnect blip never maps to a problem", () => {
    // One failed poll leaves "connecting" legs — first run must not read
    // them as down (#885's sustained-failure gate is upstream, in data).
    const rows = toStatusComponents({ connection: "connecting" });
    const d = data({
      engine: engineOf(rows, undefined),
      harness: harnessOf(rows),
      relay: relayOf(rows),
    });
    expect(firstRunProblem(d)).toBe(false);
  });

  const deadHarnessResult = {
    components: [
      { id: "relay", label: "Relay", state: "ok", reason: "connected" },
      {
        id: "harness",
        label: "Harness",
        state: "down",
        reason: "harness exited: signal SIGKILL",
      },
      {
        id: "engine",
        label: "Engine",
        state: "blocked",
        reason: "waiting for a harness",
      },
      {
        id: "model",
        label: "Model",
        state: "blocked",
        reason: "waiting for a harness",
      },
    ],
  } as never;

  test("a harness down on one poll is not yet a problem (#885)", () => {
    /* A launch agent registers after the first poll — one "no harness
       connected" read stays "starting"; two in a row is down. */
    const rows = toStatusComponents({
      result: deadHarnessResult,
      connection: "ready",
    });
    let streak = harnessDownStreak(rows, 0);
    expect(harnessOf(rows, streak)?.state).toBe("starting");
    streak = harnessDownStreak(rows, streak);
    expect(harnessOf(rows, streak)?.state).toBe("down");
    // …and a leg that comes back next poll resets the count.
    const healthy = toStatusComponents({
      result: {
        components: [
          { id: "relay", label: "Relay", state: "ok", reason: "connected" },
          { id: "harness", label: "Harness", state: "ok", reason: "up" },
          { id: "engine", label: "Engine", state: "ok", reason: "up" },
          { id: "model", label: "Model", state: "ok", reason: "up" },
        ],
      } as never,
      connection: "ready",
    });
    streak = harnessDownStreak(healthy, streak);
    expect(streak).toBe(0);
    expect(harnessOf(healthy, streak)?.state).toBe("ok");

    const d = data({
      engine: engineOf(rows, deadHarnessResult),
      harness: harnessOf(rows, 1),
      relay: relayOf(rows),
    });
    expect(firstRunProblem(d)).toBe(false);
  });

  test("a degraded harness reads starting, never down (#885)", () => {
    const rows = toStatusComponents({
      result: {
        components: [
          { id: "relay", label: "Relay", state: "ok", reason: "connected" },
          {
            id: "harness",
            label: "Harness",
            state: "degraded",
            reason: "heartbeat stale 42s",
          },
          {
            id: "engine",
            label: "Engine",
            state: "ok",
            reason: "running hermes",
          },
          { id: "model", label: "Model", state: "ok", reason: "up" },
        ],
      } as never,
      connection: "ready",
    });
    expect(harnessOf(rows, 99)?.state).toBe("starting");
  });

  test("a down harness leg (2 polls) from a real result is a problem", () => {
    const rows = toStatusComponents({
      result: deadHarnessResult,
      connection: "ready",
    });
    const d = data({
      engine: engineOf(rows, deadHarnessResult),
      harness: harnessOf(rows, 2),
      relay: relayOf(rows),
    });
    expect(d.settings.harness?.state).toBe("down");
    expect(firstRunProblem(d)).toBe(true);
    const el = problem(d);
    expect(el?.textContent).toMatch(/starts the engine isn't answering/);
    expect(el?.textContent).not.toMatch(/\bharness\b/i);
  });

  test("a slow engine: the note at 40s, the problem only past 90s (#885)", () => {
    const harness = { state: "ok" } as const;
    const okRelay = { state: "ok" } as const;
    const engine = (): V3Data["settings"]["engine"] => ({
      state: "starting",
      name: "Hermes",
    });

    // 40s of a healthy-but-slow first boot: calm, not a problem.
    const e40 = engine();
    startGate(e40, harness, 40_000);
    expect(e40.slow).toBe(true);
    expect(e40.stuck).toBeUndefined();
    const d40 = data({ engine: e40, harness, relay: okRelay });
    expect(firstRunProblem(d40)).toBe(false);

    // Past the engine's own window it is the problem, helper clears.
    const e91 = engine();
    startGate(e91, harness, 91_000);
    expect(e91.stuck).toBe("engine");
    expect(e91.slow).toBeUndefined();
    expect(
      firstRunProblem(data({ engine: e91, harness, relay: okRelay })),
    ).toBe(true);

    // Recovery: a state that is not "starting" marks nothing.
    const ok: V3Data["settings"]["engine"] = {
      state: "ok",
      name: "Hermes",
    };
    startGate(ok, harness, 200_000);
    expect(ok.stuck).toBeUndefined();
    expect(ok.slow).toBeUndefined();
    expect(firstRunProblem(data({ engine: ok, harness, relay: okRelay }))).toBe(
      false,
    );

    // The helper keeps its own ~20s window, independent of the engine's.
    const e25 = engine();
    startGate(e25, { state: "down" }, 25_000);
    expect(e25.stuck).toBe("harness");
    expect(e25.slow).toBeUndefined();
  });
});
