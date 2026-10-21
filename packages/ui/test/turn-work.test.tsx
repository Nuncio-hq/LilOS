// @vitest-environment happy-dom
/* #770: a turn's work is ONE folded line ("Worked 2m · read 2 files, 1
   search") built from the real steps; it opens to every step, and while the
   turn runs it reads "Working · {step}" with the output tail under the
   running step. Your own message is a right-aligned bubble whose line under
   it carries the time and a hover "Rewind to here". */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TurnWork } from "../src/conversation/turn-work";
import { AgentTurn } from "../src/conversation/turns";
import { UserTurn } from "../src/conversation/user-turn";
import { formatDur, stepFacts, stepKind } from "../src/conversation/work-steps";
import type { Step } from "../src/types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

const step = (
  tool: string,
  input: Record<string, unknown>,
  extra = {},
): Step => ({
  tool,
  input,
  output: "",
  ...extra,
});

const READ = step("read_file", { path: "a.ts" });
const READ2 = step("read_file", { path: "b.ts" });
const SEARCH = step("search_files", { pattern: "foo" });

describe("work line facts", () => {
  test("kinds group by what the step did, whichever engine named the tool", () => {
    expect(stepKind(READ)).toBe("read");
    expect(stepKind(step("Bash", { command: "ls" }))).toBe("run");
    expect(stepKind(step("terminal", { command: "ls" }))).toBe("run");
    expect(stepKind(step("mystery", {}))).toBe("other");
  });

  test("counts read like the prototype's line", () => {
    expect(stepFacts([READ, READ2, SEARCH])).toEqual([
      "read 2 files",
      "1 search",
    ]);
    expect(
      stepFacts([
        step("terminal", { command: "x" }, { status: "failed" }),
        step("terminal", { command: "y" }),
      ]),
    ).toEqual(["ran 2 commands", "1 failed"]);
    expect(stepFacts([step("mystery", {})])).toEqual(["1 step"]);
  });

  test("durations read short", () => {
    expect(formatDur(12)).toBe("12s");
    expect(formatDur(120)).toBe("2m");
    expect(formatDur(125)).toBe("2m 5s");
    expect(formatDur(3900)).toBe("1h 5m");
  });
});

describe("TurnWork", () => {
  test("a settled turn is one folded line with counts; clicking opens every step", () => {
    const { container } = render(
      <TurnWork
        steps={[READ, READ2, SEARCH]}
        dur={120}
        thought={3}
        reasoning="hmm"
      />,
    );
    const block = container.querySelector("[data-tasksteps]") as HTMLElement;
    const trigger = block.querySelector(
      '[data-slot="collapsible-trigger"]',
    ) as HTMLElement;
    expect(trigger.textContent).toContain("Worked 2m");
    expect(trigger.textContent).toContain(
      "thought for 3s, read 2 files, 1 search",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The reasoning stays in the DOM, held until found — never dropped.
    const held = block.querySelector("[hidden]");
    expect(held?.getAttribute("hidden")).toBe("until-found");
    expect(held?.textContent).toContain("hmm");
    act(() => fireEvent.click(trigger));
    expect(block.querySelector("[hidden]")).toBeNull();
    expect(block.textContent).toContain("a.ts");
    expect(block.textContent).toContain("b.ts");
    expect(block.textContent).toContain("foo");
  });

  test("a running turn says what it is on and tails the step's output", () => {
    const running = step(
      "terminal",
      { command: "bun test" },
      { running: true, output: "one\ntwo\nthree" },
    );
    const { container } = render(
      <TurnWork steps={[READ, running]} live autoOpen />,
    );
    const block = container.querySelector("[data-tasksteps]") as HTMLElement;
    const trigger = block.querySelector(
      '[data-slot="collapsible-trigger"]',
    ) as HTMLElement;
    expect(trigger.textContent).toContain("Working");
    expect(trigger.textContent).toContain("Running bun test");
    const tail = block.querySelector("[data-live-output]");
    expect(tail?.textContent).toContain("bun test");
    expect(tail?.textContent).toContain("three");
  });

  test("a step parked on an approval says so on its own row", () => {
    const { container } = render(
      <TurnWork
        steps={[step("patch", { path: "x.md" }, { running: true })]}
        live
        autoOpen
        waitingApproval
      />,
    );
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.querySelector("[data-live-output]")).toBeNull();
  });
});

describe("AgentTurn work line", () => {
  const emp = (id: string) =>
    id === "builder"
      ? ({ id, name: "Builder", role: "", status: "online" } as never)
      : undefined;

  test("a live turn that has reported nothing yet still shows its Working line", () => {
    for (const phase of ["tools", "thinking", "waiting"] as const) {
      const { container } = render(
        <AgentTurn
          r={{ from: "builder", time: "", text: "", live: true, phase }}
          emp={emp}
          last
        />,
      );
      const turn = container.querySelector("[data-agentturn]") as HTMLElement;
      expect(turn.textContent).toContain("Working");
      cleanup();
    }
  });

  test("a turn parked on a question says so on the Working line", () => {
    const { container } = render(
      <AgentTurn
        r={{
          from: "builder",
          time: "",
          text: "",
          live: true,
          phase: "waiting",
          waitingOn: "question",
        }}
        emp={emp}
        last
      />,
    );
    expect(container.textContent).toContain("Waiting for your answer");
  });
});

describe("UserTurn", () => {
  const human = (id: string) =>
    id === "user" ? { name: "Ada", color: "x" } : undefined;

  test("a bubble with the time under it; Rewind to here fires its handler", () => {
    const onRewind = vi.fn();
    const { container, getByRole } = render(
      <UserTurn
        from="user"
        time="11:02"
        text="hello there"
        human={human}
        rewind={{ running: false, onRewind }}
      />,
    );
    const root = container.querySelector("[data-userturn]") as HTMLElement;
    expect(root.className).toContain("max-w-[80%]");
    expect(root.textContent).toContain("hello there");
    expect(root.textContent).toContain("11:02");
    act(() => fireEvent.click(getByRole("button", { name: "Rewind to here" })));
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  test("a running turn greys Rewind out and names why", () => {
    const { getByRole } = render(
      <UserTurn
        from="user"
        time="11:02"
        text="hello"
        human={human}
        rewind={{ running: true, onRewind: () => {} }}
      />,
    );
    const btn = getByRole("button", {
      name: "Rewind to here",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Stop the running turn first");
  });

  test("no rewind handler, no Rewind button", () => {
    const { queryByRole } = render(
      <UserTurn from="user" time="" text="hi" human={human} />,
    );
    expect(queryByRole("button", { name: "Rewind to here" })).toBeNull();
  });
});
