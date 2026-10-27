// @vitest-environment happy-dom
/* Remove from the new chat's agent menu (#856): the picker's overflow ends
   in "Remove <agent> from LilOS…" for an agent that may go, and it asks the
   same question the agent's own page does — what goes, what stays — then
   calls `removeAgent` and the box reads as the agent that remains. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3DraftChat } from "../src/v3/v3-draft-chat";
import type { V3Actions } from "../src/v3/v3-page-types";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const agent: V3Agent = {
  id: "emp_1",
  name: "Reviewer",
  tone: "b",
  role: "QA",
  hired: "1 Oct",
  model: "Sonnet 5",
  instructions: [],
};

const other: V3Agent = {
  ...agent,
  id: "emp_2",
  name: "Maker",
  role: "Builds",
};

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    company: "Co",
    me: "Me",
    today: "Monday",
    agents: [agent, other],
    connectors: [],
    projects: [],
    goals: [],
    tickets: [],
    threads: [],
    asks: [],
    updates: [],
    schedules: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
    modelChoices: ["Sonnet 5"],
    agentFields: [],
    settings: {},
    setUp: true,
    features: { tickets: false },
    ...over,
  }) as unknown as V3Data;

const actions = (over: Partial<V3Actions> = {}): V3Actions =>
  ({
    removeAgent: vi.fn(async () => {}),
    ask: vi.fn(),
    startChat: vi.fn(async () => undefined),
    scheduleSave: vi.fn(),
    ...over,
  }) as unknown as V3Actions;

const mount = (act_: V3Actions, d = data(), go = vi.fn()) =>
  render(<V3DraftChat data={d} go={go} act={act_} id="emp_1" />);

/** The agent chip opens its menu; the remove row is its last item. */
const openMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));

describe("the agent menu's remove row", () => {
  test("the picked agent can be taken off LilOS from the menu", () => {
    mount(actions());
    openMenu();
    expect(
      screen.getByRole("menuitemradio", { name: /Reviewer/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Remove Reviewer from LilOS…" }),
    ).toBeTruthy();
  });

  test("the last LilOS agent gets no row; nor does an outside worker", () => {
    const outside: V3Agent = { ...other, kind: "outside", via: "x" };
    mount(actions(), data({ agents: [agent, outside] }));
    /* An outside worker is not "another agent that remains": Reviewer is
       still the last LilOS agent here, so there is no row. */
    openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /Remove .* from LilOS/ }),
    ).toBeNull();
    // The outside worker picked: LilOS only watches it — nothing to remove.
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Maker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Maker" }));
    expect(
      screen.queryByRole("menuitem", { name: /Remove .* from LilOS/ }),
    ).toBeNull();
    // And alone: no row either.
    cleanup();
    mount(actions(), data({ agents: [agent] }));
    openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /Remove .* from LilOS/ }),
    ).toBeNull();
  });

  test("no removeAgent action: no row (D-#19)", () => {
    mount(actions({ removeAgent: undefined }));
    openMenu();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("the ask the row opens", () => {
  test("says what goes and what stays, then removes and the box moves on", async () => {
    const act_ = actions();
    const go = vi.fn();
    mount(act_, data(), go);
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove Reviewer from LilOS…" }),
    );
    const ask = screen.getByRole("group", {
      name: "Remove Reviewer from LilOS",
    });
    expect(ask.textContent).toContain("Remove Reviewer from LilOS?");
    expect(ask.textContent).toContain("Goes:");
    expect(ask.textContent).toContain("you can add it back any time");
    expect(act_.removeAgent).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from LilOS" }),
      );
    });
    expect(act_.removeAgent).toHaveBeenCalledWith("emp_1");
    // The question closes; nothing navigated away.
    expect(screen.queryByRole("group")).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  test("Cancel puts the question away and the keyboard lands back on the chip", () => {
    mount(actions());
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove Reviewer from LilOS…" }),
    );
    // The question opens on its safe answer, like everywhere it is asked.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reviewer" }),
    );
  });

  test("a refused removal keeps the question open", async () => {
    mount(actions({ removeAgent: vi.fn().mockRejectedValue(new Error("no")) }));
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove Reviewer from LilOS…" }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from LilOS" }),
      );
    });
    expect(
      screen.getByRole("group", { name: "Remove Reviewer from LilOS" }),
    ).toBeTruthy();
  });
});
