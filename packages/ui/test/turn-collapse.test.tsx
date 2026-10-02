// @vitest-environment happy-dom
/* AC tests for issue #320: while a turn runs its steps/subagents/reasoning
   blocks auto-open as today, but a user's collapse is sticky — nothing in
   that turn re-opens a block the user closed, and a block the user opened
   stays open at turn end. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../src/components/ai-elements/reasoning";
import { TurnSubagents } from "../src/conversation/subagents";
import { AgentTurn, TurnSteps } from "../src/conversation/turns";
import type { EmpFn, Reply, Step, Subagent } from "../src/types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
afterEach(cleanup);

const EMP = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "m",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === EMP.id ? EMP : undefined);

const step = (tool: string, running = false): Step => ({
  tool,
  input: { command: `${tool}-cmd` },
  output: `${tool}-out`,
  running,
});

const agent = (id: string, status: Subagent["status"]): Subagent => ({
  id,
  name: `Agent ${id}`,
  task: `task-${id}`,
  status,
  steps: [step("read")],
  result: status === "done" ? `result-${id}` : undefined,
});

/* A collapsed panel may stay mounted under `hidden="until-found"` so
   find-in-page can reveal folded content (#400 reasoning) — only a mounted
   AND unhidden panel counts as open. */
const panel = (container: HTMLElement) => {
  const el = container.querySelector('[data-slot="collapsible-content"]');
  return el && !el.hasAttribute("hidden") ? el : null;
};

function triggerOf(container: HTMLElement) {
  const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
  if (!trigger) throw new Error("no collapsible trigger found");
  return trigger as HTMLElement;
}

describe("AC-1/2: user collapse beats auto-open while the turn runs", () => {
  test("TurnSteps: click collapses and it stays collapsed as steps land", () => {
    const { container, rerender } = render(
      <TurnSteps steps={[step("patch", true)]} autoOpen />,
    );
    // Auto-open as today: the steps panel is in the DOM.
    expect(panel(container)).toBeTruthy();

    act(() => fireEvent.click(triggerOf(container)));
    // Collapsed: the panel unmounts; the header keeps the live "patch…" state.
    expect(panel(container)).toBeFalsy();
    expect(container.textContent).toContain("patch…");

    // Two more steps land — the block must not re-open.
    rerender(
      <TurnSteps
        steps={[step("patch"), step("read"), step("patch", true)]}
        autoOpen
      />,
    );
    expect(panel(container)).toBeFalsy();
    expect(container.textContent).toContain("patch…");
  });

  test("TurnSubagents: same collapse rules", () => {
    const { container, rerender } = render(
      <TurnSubagents agents={[agent("a1", "running")]} emp={emp} />,
    );
    expect(panel(container)).toBeTruthy();

    act(() => fireEvent.click(triggerOf(container)));
    expect(panel(container)).toBeFalsy();

    rerender(
      <TurnSubagents
        agents={[agent("a1", "running"), agent("a2", "running")]}
        emp={emp}
      />,
    );
    expect(panel(container)).toBeFalsy();
    expect(container.textContent).toContain("2 of 2 subagents running");
  });

  test("Reasoning: collapse while streaming sticks", () => {
    const { container } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>thinking aloud</ReasoningContent>
      </Reasoning>,
    );
    expect(panel(container)).toBeTruthy();

    act(() => fireEvent.click(triggerOf(container)));
    expect(panel(container)).toBeFalsy();
    expect(container.textContent).toContain("Thinking...");
  });
});

describe("AC-3: turn end collapses unless the user opened it", () => {
  test("TurnSteps: untouched auto-open collapses at turn end", () => {
    const { container, rerender } = render(
      <TurnSteps steps={[step("patch", true)]} autoOpen />,
    );
    expect(panel(container)).toBeTruthy();
    rerender(<TurnSteps steps={[step("patch")]} autoOpen={false} />);
    expect(panel(container)).toBeFalsy();
    expect(container.textContent).toContain("1 step");
  });

  test("TurnSteps: a user-opened block stays open at turn end", () => {
    const { container, rerender } = render(
      <TurnSteps steps={[step("patch", true)]} autoOpen />,
    );
    // Collapse, then re-open while the turn still runs.
    act(() => fireEvent.click(triggerOf(container)));
    act(() => fireEvent.click(triggerOf(container)));
    expect(panel(container)).toBeTruthy();

    rerender(<TurnSteps steps={[step("patch")]} autoOpen={false} />);
    expect(panel(container)).toBeTruthy();
  });

  test("AgentTurn: user-opened steps survive the live→relay-row id swap", () => {
    /* The web thread keys rows `r.turnId ?? r.id`; the settled card claims its
       relay row id while turnId stays — so AgentTurn must NOT remount (a
       remount drops TurnSteps' userSet and silently folds a user-opened
       block). Rendered through the same list shape thread/focus views use. */
    const live: Reply = {
      id: "live-t1",
      turnId: "t1",
      from: "builder",
      time: "",
      text: "working",
      steps: [step("patch", true)],
      phase: "tools",
      live: true,
    };
    const settled: Reply = {
      ...live,
      id: "m1",
      phase: "done",
      live: false,
      steps: [step("patch")],
    };
    const row = (r: Reply) => (
      <div key={r.turnId ?? r.id}>
        <AgentTurn r={r} emp={emp} />
      </div>
    );
    const { container, rerender } = render(<div>{row(live)}</div>);
    const stepsBlock = () =>
      container.querySelector("[data-tasksteps]") as HTMLElement;
    expect(stepsBlock()).toBeTruthy();

    // Collapse, then re-open while the turn runs (user-opened).
    const trigger = () =>
      stepsBlock().querySelector(
        '[data-slot="collapsible-trigger"]',
      ) as HTMLElement;
    act(() => fireEvent.click(trigger()));
    act(() => fireEvent.click(trigger()));
    expect(panel(stepsBlock())).toBeTruthy();

    // Turn ends; the card claims the relay row (id swap, turnId stable).
    rerender(<div>{row(settled)}</div>);
    expect(panel(stepsBlock())).toBeTruthy();
  });

  test("Reasoning: user-opened survives the end-of-stream auto-close", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>thinking aloud</ReasoningContent>
      </Reasoning>,
    );
    // User toggles it during the stream (collapse + re-open).
    act(() => fireEvent.click(triggerOf(container)));
    act(() => fireEvent.click(triggerOf(container)));
    expect(panel(container)).toBeTruthy();

    rerender(
      <Reasoning isStreaming={false} defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>thinking aloud</ReasoningContent>
      </Reasoning>,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(panel(container)).toBeTruthy();
    vi.useRealTimers();
  });

  test("Reasoning: untouched still auto-closes when the stream ends", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>thinking aloud</ReasoningContent>
      </Reasoning>,
    );
    rerender(
      <Reasoning isStreaming={false} defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>thinking aloud</ReasoningContent>
      </Reasoning>,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(panel(container)).toBeFalsy();
    vi.useRealTimers();
  });
});
