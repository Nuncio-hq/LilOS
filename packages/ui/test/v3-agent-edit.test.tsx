// @vitest-environment happy-dom
/* An agent's page edits and removes the agent in place. The real app's shape
   (no CEO, no tickets, the engine's fields in `agentFields`) is the fixture:
   a control the app cannot back must not be drawn, Esc must close the editing
   and not the peek behind it, and a save writes only what changed. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { V3AgentPage } from "../src/v3/v3-agent";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions, V3Route } from "../src/v3/v3-page-types";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

const agent: V3Agent = {
  id: "emp_1",
  name: "Reviewer",
  tone: "b",
  role: "QA",
  hired: "1 Oct",
  model: "Sonnet 5",
  description: "Reads every diff",
  instructions: ["Comment with file:line.", "Never push to main."],
};

/* A second agent, so emp_1 is not the last one on the team — the last LilOS
   agent never gets a remove control (#856). `two` is the roster remove tests
   need; `data()` alone leaves one agent for everything else. */
const other: V3Agent = {
  ...agent,
  id: "emp_2",
  name: "Maker",
  instructions: [],
};
const two: V3Agent[] = [agent, other];

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    company: "Co",
    me: "Me",
    today: "Monday",
    agents: [agent],
    connectors: [],
    projects: [],
    goals: [],
    tickets: [],
    threads: [
      {
        id: "t1",
        agentId: "emp_1",
        title: "Review #4",
        status: "done",
        startedAt: "10:00",
        minutes: 3,
        step: 1,
        context: 1,
        folder: "~",
        changes: [],
        turns: [],
      },
    ],
    asks: [],
    updates: [],
    schedules: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
    modelChoices: ["Sonnet 5", "Haiku 5"],
    agentFields: ["description", "model", "instructions"],
    settings: {},
    setUp: true,
    features: { tickets: false },
    ...over,
  }) as unknown as V3Data;

const actions = (over: Partial<V3Actions> = {}): V3Actions =>
  ({
    updateAgent: vi.fn(async () => undefined),
    removeAgent: vi.fn(async () => {}),
    ask: vi.fn(),
    scheduleSave: vi.fn(),
    scheduleToggle: vi.fn(),
    scheduleRunNow: vi.fn(),
    scheduleDelete: vi.fn(),
    ...over,
  }) as unknown as V3Actions;

const mount = (act_: V3Actions, d = data(), go = vi.fn()) =>
  render(<V3AgentPage data={d} go={go} act={act_} id="emp_1" />);

/** The shell's Esc handler, in the shape it has: it leaves a key a panel
    already used alone. */
function shellEsc() {
  const closePeek = vi.fn();
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") closePeek();
  };
  window.addEventListener("keydown", onKey);
  return { closePeek, off: () => window.removeEventListener("keydown", onKey) };
}

const press = (el: Element, key: string) =>
  fireEvent.keyDown(el, { key, bubbles: true });

describe("capability by presence", () => {
  test("no updateAgent/removeAgent: no Edit, no mute switch, no Remove", () => {
    mount(
      actions({ updateAgent: undefined, removeAgent: undefined }),
      data({ agents: two }),
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove from LilOS" }),
    ).toBeNull();
  });

  test("an outside worker has none of it: LilOS only watches it", () => {
    const outside: V3Agent = { ...agent, kind: "outside", via: "x" };
    render(
      <V3AgentPage
        data={data({ agents: [outside, other] })}
        go={vi.fn()}
        act={actions()}
        id="emp_1"
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove from LilOS" }),
    ).toBeNull();
  });

  test("the fields the engine does not list are not offered", () => {
    mount(actions(), data({ agentFields: undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Role")).toBeTruthy();
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });
});

describe("edit", () => {
  test("Save writes only what changed", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Maker " },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Ship small PRs." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      name: "Maker",
      instructions: "Ship small PRs.",
    });
    // Saved: back to reading.
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  test("the model is picked from the app's choices", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Haiku 5" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      model: "Haiku 5",
    });
  });

  test("an unchanged form just closes; an empty name cannot be saved", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(act_.updateAgent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(act_.updateAgent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  test("Esc cancels the editing and the peek behind it keeps its key", () => {
    const shell = shellEsc();
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Maker" },
    });
    press(screen.getByLabelText("Role"), "Escape");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("heading", { name: /Reviewer/ })).toBeTruthy();
    expect(act_.updateAgent).not.toHaveBeenCalled();
    expect(shell.closePeek).not.toHaveBeenCalled();
    // Reading again, Esc is the shell's.
    press(document.body, "Escape");
    expect(shell.closePeek).toHaveBeenCalledTimes(1);
    shell.off();
  });

  test("a guarded model waits for a confirm, then pins alone", async () => {
    const updateAgent = vi
      .fn<NonNullable<V3Actions["updateAgent"]>>()
      .mockResolvedValueOnce({ confirmModel: "Costs 5x more. Pin it?" })
      .mockResolvedValueOnce(undefined);
    mount(actions({ updateAgent }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Haiku 5" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByText("Costs 5x more. Pin it?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pin anyway" }));
    });
    expect(updateAgent).toHaveBeenLastCalledWith("emp_1", {
      model: "Haiku 5",
      confirmModel: true,
    });
    expect(screen.queryByText("Costs 5x more. Pin it?")).toBeNull();
  });

  test("a failed save keeps what you typed", async () => {
    const updateAgent = vi.fn().mockRejectedValue(new Error("nope"));
    mount(actions({ updateAgent }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Maker" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Maker",
    );
  });
});

describe("notifications", () => {
  test("the switch applies at once and follows the data", async () => {
    const act_ = actions();
    const { rerender } = mount(act_);
    const sw = screen.getByRole("switch", {
      name: "Notifications for Reviewer",
    });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", { muted: true });
    rerender(
      <V3AgentPage
        data={data({ agents: [{ ...agent, muted: true }] })}
        go={vi.fn()}
        act={act_}
        id="emp_1"
      />,
    );
    expect(
      screen
        .getByRole("switch", { name: "Notifications for Reviewer" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("Muted")).toBeTruthy();
  });
});

describe("remove", () => {
  test("asks first, says what goes and what stays, then goes to People", async () => {
    const act_ = actions();
    const go = vi.fn<(r: V3Route) => void>();
    mount(act_, data({ agents: two }), go);
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    const ask = screen.getByRole("group", {
      name: "Remove Reviewer from LilOS",
    });
    expect(ask.textContent).toContain("Remove Reviewer from LilOS?");
    expect(ask.textContent).toContain("Reviewer and its 1 thread in LilOS");
    expect(ask.textContent).toContain("engine profile and CLI login");
    expect(act_.removeAgent).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from LilOS" }),
      );
    });
    expect(act_.removeAgent).toHaveBeenCalledWith("emp_1");
    expect(go).toHaveBeenCalledWith({ page: "people" });
  });

  test("a running thread is named in the ask: it is stopped first", () => {
    mount(
      actions(),
      data({
        agents: two,
        threads: [
          {
            id: "t-live",
            agentId: "emp_1",
            title: "Live work",
            status: "working",
            startedAt: "11:00",
            minutes: 4,
            step: 1,
            context: 1,
            folder: "~",
            changes: [],
            turns: [],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    expect(
      screen.getByRole("group", { name: "Remove Reviewer from LilOS" })
        .textContent,
    ).toContain("Anything running is stopped first");
  });

  test("with the company layer paused Remove is still there — and lands on People", async () => {
    const act_ = actions();
    const go = vi.fn<(r: V3Route) => void>();
    // shownData's shape, as the paused shell hands it down (D-#836):
    // company off, no ceoId.
    mount(
      act_,
      data({ agents: two, features: { company: false, tickets: false } }),
      go,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from LilOS" }),
      );
    });
    expect(act_.removeAgent).toHaveBeenCalledWith("emp_1");
    expect(go).toHaveBeenCalledWith({ page: "people" });
  });

  test("the last LilOS agent has no remove control", () => {
    mount(actions(), data());
    expect(
      screen.queryByRole("button", { name: "Remove from LilOS" }),
    ).toBeNull();
  });

  test("Cancel and Esc put the question away without removing", () => {
    const shell = shellEsc();
    const act_ = actions();
    mount(act_, data({ agents: two }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    press(document.body, "Escape");
    expect(screen.queryByRole("group")).toBeNull();
    expect(act_.removeAgent).not.toHaveBeenCalled();
    expect(shell.closePeek).not.toHaveBeenCalled();
    shell.off();
  });

  test("a refused removal stays on the page", async () => {
    const go = vi.fn();
    mount(
      actions({ removeAgent: vi.fn().mockRejectedValue(new Error("no")) }),
      data({ agents: two }),
      go,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from LilOS" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from LilOS" }),
      );
    });
    expect(go).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "Remove Reviewer from LilOS" }),
    ).toBeTruthy();
  });

  test("whoever holds the CEO position has no remove control", () => {
    mount(actions(), data({ agents: two, ceoId: "emp_1" }));
    expect(
      screen.queryByRole("button", { name: "Remove from LilOS" }),
    ).toBeNull();
  });
});

/* Click-to-rename on the header (#870): the name itself, or ⋯ → Rename,
   swaps it for a box; Enter (or leaving) saves just the name through
   updateAgent, Esc keeps the old one and touches nothing behind it. */
describe("rename in the header", () => {
  test("clicking the name opens the box; Enter saves through updateAgent", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    const box = screen.getByLabelText("Agent name");
    expect(box).toHaveProperty("value", "Reviewer");
    fireEvent.change(box, { target: { value: "Rex" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", { name: "Rex" });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  test("⋯ → Rename opens the same box", () => {
    mount(actions());
    fireEvent.click(screen.getByRole("button", { name: "Agent actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByLabelText("Agent name")).toBeTruthy();
  });

  test("Esc keeps the old name and never reaches the peek behind", () => {
    const shell = shellEsc();
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    const box = screen.getByLabelText("Agent name");
    fireEvent.change(box, { target: { value: "Rex" } });
    press(box, "Escape");
    expect(act_.updateAgent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    expect(screen.getByRole("button", { name: "Reviewer" })).toBeTruthy();
    expect(shell.closePeek).not.toHaveBeenCalled();
    shell.off();
  });

  test("an unchanged name saves nothing; an outside worker cannot rename", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Agent name"), {
        key: "Enter",
      });
    });
    expect(act_.updateAgent).not.toHaveBeenCalled();
    // An outside worker has no engine fields at all — and no rename control.
    cleanup();
    mount(
      act_,
      data({
        agents: [{ ...agent, kind: "outside", via: "x" }],
      }),
    );
    expect(screen.queryByRole("button", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent actions" })).toBeNull();
  });
});
