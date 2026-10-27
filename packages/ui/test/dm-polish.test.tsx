// @vitest-environment happy-dom
/* Issue #71, ui layer: AC-2 the employee avatar shows the agent's face toned
   by name (no image; the orb went in #872 — one letter avatar everywhere),
   AC-4 a waiting surface says "needs you" / "Waiting for
   approval". (AC-1's avatar-less `Row` column-width check went with
   `feed/row.tsx` in #770, when turns became a full-width `AgentTurn` and a
   right-aligned `UserTurn` bubble with no avatar grid to keep wide. AC-3
   `· now:` and the DM-list / sidebar "!" badge belonged to the old DM home
   and sidebar, which are gone.) */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ModelPicker } from "../src/chat/model-picker";
import { TurnWork } from "../src/conversation/turn-work";
import { AgentTurn } from "../src/conversation/turns";
import { PHASE_LABEL } from "../src/lib/helpers";
import { EmployeeAvatar } from "../src/shell/avatars";
import type { Employee } from "../src/types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollTo === "undefined") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
afterEach(cleanup);

const EMP: Employee = {
  id: "emp_default",
  name: "Default",
  role: "Builder",
  status: "online",
  profile: "builder",
  model: "fake-large",
  now: "",
  instructions: "",
  respondTo: "me",
};

describe("issue #71", () => {
  test("AC-2 the employee avatar is the agent's letter face, no image", () => {
    const { container } = render(<EmployeeAvatar employee={EMP} />);
    // No <img> at all — nothing can 404 in apps/web or under file:// in
    // Electron (was: bundled mark + initial fallback, pre-#224).
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("D");
    // A coding-runtime agent wears its runtime's mark, not its own letter.
    const { container: c2 } = render(
      <EmployeeAvatar employee={{ ...EMP, runtime: "acp:devin" }} />,
    );
    expect(c2.textContent).toContain("D");
  });

  test("AC-4 a waiting session is labelled `needs you`", () => {
    expect(PHASE_LABEL.waiting).toBe("needs you");
  });

  test("AC-4 the blocked tool card says `Waiting for approval`", () => {
    const { container } = render(
      <TurnWork
        steps={[{ tool: "patch", input: {}, output: "", running: true }]}
        autoOpen
        waitingApproval
      />,
    );
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.textContent).not.toContain("Running");
  });

  test("AC-7 the picker groups by provider display name, not the slug", async () => {
    render(
      <ModelPicker
        value={{ model: "fake-large", provider: "fake" }}
        models={[
          { id: "fake-large", name: "Fake Large", provider: "fake" },
          { id: "claude-x", name: "Claude X", provider: "anthropic" },
          { id: "orphan" },
        ]}
        onChoice={() => {}}
      />,
    );
    const trigger = document.body.querySelector(
      '[data-slot="model-picker-trigger"]',
    );
    expect(trigger).toBeTruthy();
    await act(async () => fireEvent.click(trigger as HTMLElement));
    // The popover's "Model ›" row drills into the grouped list.
    const modelRow = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Model"),
    );
    await act(async () => fireEvent.click(modelRow as HTMLElement));
    // #194: headings carry the model count ("Fake1" = name + count).
    const headings = [
      ...document.body.querySelectorAll("[cmdk-group-heading]"),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["Fake1", "Anthropic1", "Other1"]);
  });

  test("AC-7 the turn footer shows the model's display name", () => {
    const reply = {
      id: "r1",
      from: EMP.id,
      time: "",
      text: "done",
      phase: "done",
      model: "fake-large",
    } as const;
    const emp = (id: string) => (id === EMP.id ? EMP : undefined);
    const named = render(
      <AgentTurn
        r={{ ...reply }}
        emp={emp}
        last
        models={[{ id: "fake-large", name: "Fake Large", provider: "fake" }]}
      />,
    );
    expect(named.container.textContent).toContain("Fake Large");
    expect(named.container.textContent).not.toContain("· Fake Large");
    expect(named.container.textContent).not.toContain("fake-large");
    cleanup();
    // No catalog handed down: fall back to the engine's model id.
    const bare = render(<AgentTurn r={{ ...reply }} emp={emp} last />);
    expect(bare.container.textContent).toContain("fake-large");
    expect(bare.container.textContent).not.toContain("· fake-large");
  });
});
