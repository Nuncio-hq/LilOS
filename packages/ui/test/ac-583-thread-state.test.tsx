// @vitest-environment happy-dom
/* Issue #583 — threadState words + the waiting composer; issue #585 — the
   centred system note render. Unit-level AC evidence; the e2e spec
   ac-583/585 covers the wired app. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { waitingComposer } from "../src/chat/agent-chat";
import { threadState } from "../src/lib/helpers";
import { ThreadView } from "../src/thread/thread-view";
import type { EmpFn, HumanFn, Msg, Reply, Thread } from "../src/types";

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

const BUILDER = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" ? { name: "Ada", color: "bg-blue-600" } : undefined;

const turn = (over: Partial<Reply>): Reply => ({
  id: "r1",
  from: "builder",
  time: "10:04",
  turnId: "t1",
  text: "answer",
  phase: "done",
  ...over,
});
const thread = (over: Partial<Thread>): Thread => ({
  session: "s_abc123",
  replies: [],
  ...over,
});
const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "@builder go",
};
const dmChannel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};

describe("issue #583 threadState", () => {
  test("AC-2 a turn waiting on the user reads 'needs you'", () => {
    const t = thread({
      replies: [turn({ phase: "waiting", live: true })],
    });
    expect(threadState(t)?.word).toBe("needs you");
  });
  test("AC-2 live work reads 'running'", () => {
    expect(
      threadState(thread({ replies: [turn({ live: true })] }))?.word,
    ).toBe("running");
    // A running delegated helper counts too.
    expect(
      threadState(
        thread({
          replies: [
            turn({ subagents: [{ status: "running" } as never] }),
          ],
        }),
      )?.word,
    ).toBe("running");
  });
  test("AC-2 a failed turn reads 'failed'; a stopped turn 'stopped'", () => {
    expect(
      threadState(thread({ replies: [turn({ phase: "failed" })] }))?.word,
    ).toBe("failed");
    expect(
      threadState(thread({ replies: [turn({ phase: "stopped" })] }))?.word,
    ).toBe("stopped");
    // The row's failure card (thread.alert) counts as failed too.
    expect(
      threadState(
        thread({
          alert: { kind: "model", text: "engine died", retry: true },
        }),
      )?.word,
    ).toBe("failed");
  });
  test("AC-2 a quiet finished thread says nothing", () => {
    expect(
      threadState(thread({ replies: [turn({})] })),
    ).toBeUndefined();
  });
});

describe("issue #583 waitingComposer", () => {
  test("AC-1 an approval/plan wait says 'waiting for your approval…', never 'working'", () => {
    for (const kind of ["approval", "plan", undefined] as const) {
      const w = waitingComposer("Default", kind);
      expect(w.placeholder).toContain("Default is waiting for your approval");
      expect(w.placeholder).not.toMatch(/working/i);
      expect(w.hint).not.toMatch(/working/i);
    }
  });
  test("AC-1 a question wait says 'waiting for your answer…'", () => {
    const w = waitingComposer("Default", "question");
    expect(w.placeholder).toContain("waiting for your answer");
  });
});

describe("issue #585 centred system notes", () => {
  test("AC-1 a `system` reply renders as data-sysnote, never the user's bubble", () => {
    const note: Reply = {
      id: "n1",
      from: "",
      time: "10:05",
      text: "Stopped.",
      system: true,
    };
    const { container } = render(
      <ThreadView
        root={root}
        thread={thread({ replies: [note] })}
        channel={dmChannel}
        emp={emp}
        human={human}
        resolved={{}}
        work={null}
        running={false}
        onSend={() => {}}
      />,
    );
    const sysnote = container.querySelector("[data-sysnote]");
    expect(sysnote).toBeTruthy();
    expect(sysnote?.textContent).toContain("Stopped.");
    // Centred note: no avatar row, no right-aligned user bubble.
    expect(container.querySelector(".justify-end")).toBeNull();
  });
});
