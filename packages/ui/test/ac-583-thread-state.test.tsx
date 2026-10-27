// @vitest-environment happy-dom
/* Issue #583 — the waiting composer; issue #585 — the centred system
   note render. Unit-level AC evidence; the e2e spec ac-583/585 covers the
   wired app. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { waitingComposer } from "../src/chat/agent-chat";
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

describe("issue #583 waitingComposer", () => {
  test("AC-1 an approval/plan wait says 'waiting for your approval…', never 'working'", () => {
    for (const kind of ["approval", "plan", undefined] as const) {
      const w = waitingComposer("Default", kind);
      expect(w).toContain("Default is waiting for your approval");
      expect(w).not.toMatch(/working/i);
    }
  });
  test("AC-1 a question wait says 'waiting for your answer…'", () => {
    const w = waitingComposer("Default", "question");
    expect(w).toContain("waiting for your answer");
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
