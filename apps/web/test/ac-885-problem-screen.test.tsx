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
import { engineOf, harnessOf, relayOf } from "../src/v3/settings-map";

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

  test("a down harness leg from a real result is a problem, with the helper copy", () => {
    const result = {
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
    const rows = toStatusComponents({ result, connection: "ready" });
    const d = data({
      engine: engineOf(rows, result),
      harness: harnessOf(rows),
      relay: relayOf(rows),
    });
    expect(d.settings.harness?.state).toBe("down");
    expect(firstRunProblem(d)).toBe(true);
    const el = problem(d);
    expect(el?.textContent).toMatch(/starts the engine isn't answering/);
    expect(el?.textContent).not.toMatch(/\bharness\b/i);
  });
});
