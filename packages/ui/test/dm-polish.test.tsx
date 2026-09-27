// @vitest-environment happy-dom
/* Issue #71, ui layer: AC-1 avatar-less feed rows keep the content column at
   full width, AC-2 the Hermes avatar bundles its mark and falls back to an
   initial, AC-3 `· now:` hides when empty, AC-4 waiting surfaces read
   "needs you" / "Waiting for approval". */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ModelPicker } from "../src/chat/model-picker";
import { AgentTurn, TurnSteps } from "../src/conversation/turns";
import { EmployeeHome } from "../src/employee/employee-home";
import { Row } from "../src/feed/row";
import { NO_WS, PHASE_LABEL } from "../src/lib/helpers";
import { HermesAvatar } from "../src/shell/avatars";
import { Sidebar } from "../src/shell/sidebar";
import type { Employee, Msg } from "../src/types";

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

const emp = (id: string) => (id === EMP.id ? EMP : undefined);
const human = () => undefined;

describe("issue #71", () => {
  test("AC-1 a row with no avatar still renders content at the wide column", () => {
    const { container } = render(
      <Row from="system" emp={emp} human={human}>
        <p>notice</p>
      </Row>,
    );
    const grid = container.firstElementChild;
    const content = grid?.querySelector(".is-assistant");
    expect(content?.className).toContain("col-start-2");
  });

  test("AC-2 the Hermes avatar bundles its mark and falls back to an initial", () => {
    const { container } = render(<HermesAvatar name="Default" />);
    const img = container.querySelector("img");
    // Bundled asset URL, not the prototype-only absolute path that 404s in
    // apps/web and under file:// in Electron.
    expect(img?.getAttribute("src")).not.toBe("/hermes.svg");
    expect(
      container.querySelector('[data-slot="avatar-fallback"]')?.textContent,
    ).toBe("D");
  });

  test("AC-3 `· now:` is hidden when the employee has no now value", () => {
    const { container } = render(
      <EmployeeHome
        e={EMP}
        feed={[]}
        threadId={null}
        emp={emp}
        human={human}
        onNav={() => {}}
        onProfile={() => {}}
        onOpen={() => {}}
        onSend={() => {}}
        panelOpen={false}
        onPanel={() => {}}
        folders={[]}
        pick={NO_WS}
        setPick={() => {}}
      />,
    );
    const subtitle = container.querySelector("header .text-xs");
    expect(subtitle.textContent).not.toContain("now:");
    cleanup();
    const again = render(
      <EmployeeHome
        e={{ ...EMP, now: "shipping #71" }}
        feed={[]}
        threadId={null}
        emp={emp}
        human={human}
        onNav={() => {}}
        onProfile={() => {}}
        onOpen={() => {}}
        onSend={() => {}}
        panelOpen={false}
        onPanel={() => {}}
        folders={[]}
        pick={NO_WS}
        setPick={() => {}}
      />,
    );
    expect(
      again.container.querySelector("header .text-xs")?.textContent,
    ).toContain("now: shipping #71");
  });

  test("AC-4 a waiting session reads `needs you` in the DM list and the sidebar badge", () => {
    const waitingReply = {
      id: "r1",
      from: EMP.id,
      time: "12:00",
      text: "",
      phase: "waiting" as const,
      live: true,
      waitingOn: "approval" as const,
      steps: [
        {
          tool: "patch",
          input: {},
          output: "",
          running: true,
        },
      ],
    };
    const feed: Msg[] = [
      {
        kind: "msg",
        id: "m1",
        from: "user",
        time: "12:00",
        text: "Add a note",
        thread: { session: "s1", replies: [waitingReply] },
      },
    ];
    const home = render(
      <EmployeeHome
        e={EMP}
        feed={feed}
        threadId={null}
        emp={emp}
        human={human}
        onNav={() => {}}
        onProfile={() => {}}
        onOpen={() => {}}
        onSend={() => {}}
        panelOpen={false}
        onPanel={() => {}}
        folders={[]}
        pick={NO_WS}
        setPick={() => {}}
      />,
    );
    expect(
      home.container.querySelector("[data-session]")?.textContent,
    ).toContain("needs you");
    expect(PHASE_LABEL.waiting).toBe("needs you");
    cleanup();
    const side = render(
      <Sidebar
        navOpen
        hiddenWhenClosed={false}
        me={{ name: "Oscar", color: "bg-blue-600" }}
        companyChannels={[]}
        projects={[]}
        folders={[]}
        employees={[EMP]}
        view={{ kind: "dm", id: "" }}
        theme="light"
        isProjectDefaultOpen={() => false}
        onSetTheme={() => {}}
        onCloseNav={() => {}}
        onGoChannel={() => {}}
        onGoDM={() => {}}
        onOpenTickets={() => {}}
        onAddFolder={() => {}}
        badges={{ [EMP.id]: { approvals: 1 } }}
      />,
    );
    expect(
      side.container.querySelector("[data-badge-approvals]")?.textContent,
    ).toBe("needs you");
  });

  test("AC-4 the blocked tool card says `Waiting for approval`", () => {
    const { container } = render(
      <TurnSteps
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
        model="fake-large"
        models={[
          { id: "fake-large", name: "Fake Large", provider: "fake" },
          { id: "claude-x", name: "Claude X", provider: "anthropic" },
          { id: "orphan" },
        ]}
        onModel={() => {}}
      />,
    );
    const trigger =
      document.body.querySelector('[data-slot="model-selector-trigger"]') ??
      document.body.querySelector("button");
    expect(trigger).toBeTruthy();
    (trigger as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const headings = [
      ...document.body.querySelectorAll("[cmdk-group-heading]"),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["Fake", "Anthropic", "Other"]);
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
    expect(named.container.textContent).toContain("· Fake Large");
    expect(named.container.textContent).not.toContain("fake-large");
    cleanup();
    // No catalog handed down: fall back to the engine's model id.
    const bare = render(<AgentTurn r={{ ...reply }} emp={emp} last />);
    expect(bare.container.textContent).toContain("· fake-large");
  });
});
