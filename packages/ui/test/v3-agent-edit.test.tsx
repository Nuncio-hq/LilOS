// @vitest-environment happy-dom
/* An agent's page edits in place, Notion-style (#872): no edit mode, no
   page Save/Cancel — click the name or description, Enter or leaving saves
   just that field, Esc puts it back; the model's menu saves on pick and a
   guarded model asks before it pins; instructions save on blur. Fields the
   agent's own runtime cannot write (D-#761) render as plain text. The real
   app's shape (no CEO, no tickets) is the fixture; removing and the name's
   click-to-rename keep working as they did. */
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
import type { V3Agent, V3Runtime } from "../src/v3/v3-types";

afterEach(cleanup);

const agent: V3Agent = {
  id: "emp_1",
  name: "Reviewer",
  tone: "b",
  role: "QA",
  hired: "1 Oct",
  profile: "reviewer",
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

const HERMES: V3Runtime = {
  id: "hermes",
  label: "Hermes",
  available: true,
  isDefault: true,
  updatable: ["name", "description", "soul", "model"],
  models: ["Sonnet 5", "Haiku 5"],
};
const DEVIN: V3Runtime = {
  id: "acp:devin",
  label: "Devin",
  available: true,
  tone: "b",
  updatable: ["name", "description", "soul", "model"],
  models: ["SWE-2 · High", "SWE-2 · Medium"],
};

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
  test("no updateAgent/removeAgent: nothing editable, no mute, no Remove", () => {
    mount(
      actions({ updateAgent: undefined, removeAgent: undefined }),
      data({ agents: two }),
    );
    expect(screen.queryByRole("button", { name: "QA" })).toBeNull();
    expect(screen.queryByLabelText("Description")).toBeNull();
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
    expect(screen.queryByRole("button", { name: "QA" })).toBeNull();
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove from LilOS" }),
    ).toBeNull();
  });

  test("the fields the engine does not list read as text, never inputs", () => {
    mount(actions(), data({ agentFields: undefined }));
    // The name is the company's record — still editable.
    expect(screen.getByRole("button", { name: "Reviewer" })).toBeTruthy();
    // Engine-owned fields sit read-only.
    expect(screen.getByText("Reads every diff")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Reads every diff" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Default model" })).toBeNull();
  });
});

describe("edit in place", () => {
  test("the description saves on Enter; Esc cancels without touching the record", async () => {
    const act_ = actions();
    const shell = shellEsc();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Reads every diff" }));
    const box = screen.getByLabelText("Description");
    fireEvent.change(box, { target: { value: "Reviews" } });
    await act(async () => {
      press(box, "Enter");
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      description: "Reviews",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reads every diff" }));
    const again = screen.getByLabelText("Description");
    fireEvent.change(again, { target: { value: "Nope" } });
    press(again, "Escape");
    expect(act_.updateAgent).toHaveBeenCalledTimes(1);
    expect(shell.closePeek).not.toHaveBeenCalled();
    shell.off();
  });

  test("the description saves on blur", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Reads every diff" }));
    const box = screen.getByLabelText("Description");
    fireEvent.change(box, { target: { value: "Ships PRs" } });
    await act(async () => {
      fireEvent.blur(box);
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      description: "Ships PRs",
    });
  });

  test("the model saves the moment it is picked", async () => {
    const act_ = actions();
    mount(act_);
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Haiku 5" }));
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      model: "Haiku 5",
    });
  });

  test("instructions save on blur; Esc puts the old text back", async () => {
    const act_ = actions();
    mount(act_);
    const area = screen.getByLabelText("Instructions");
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: "Ship small PRs." } });
    await act(async () => {
      fireEvent.blur(area);
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_1", {
      instructions: "Ship small PRs.",
    });

    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: "Nope" } });
    const shell = shellEsc();
    /* Real focus, not fireEvent.focus: Esc's blur() must actually fire the
       onBlur commit path — the stale-closure save this test guards. */
    area.focus();
    press(area, "Escape");
    expect(act_.updateAgent).toHaveBeenCalledTimes(1);
    expect(shell.closePeek).not.toHaveBeenCalled();
    expect((area as HTMLTextAreaElement).value).toBe(
      "Comment with file:line.\n\nNever push to main.",
    );
    shell.off();
  });

  test("a failed instructions save keeps the typed text", async () => {
    const updateAgent = vi.fn().mockRejectedValue(new Error("engine down"));
    mount(actions({ updateAgent }));
    const area = screen.getByLabelText("Instructions");
    area.focus();
    fireEvent.change(area, { target: { value: "Never skip tests." } });
    await act(async () => {
      area.blur();
    });
    expect(screen.getByText(/Couldn't save — engine down/)).toBeTruthy();
    /* The draft is not discarded on a failed commit — blur keeps the typed
       text until the store echoes a save that landed. */
    expect((area as HTMLTextAreaElement).value).toBe("Never skip tests.");
  });

  test("a guarded model asks in place, then pins alone", async () => {
    const updateAgent = vi
      .fn<NonNullable<V3Actions["updateAgent"]>>()
      .mockResolvedValueOnce({ confirmModel: "Costs 5x more. Pin it?" })
      .mockResolvedValueOnce(undefined);
    mount(actions({ updateAgent }));
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Haiku 5" }));
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

  test("a newer pick dismisses a stale model prompt", async () => {
    const updateAgent = vi
      .fn<NonNullable<V3Actions["updateAgent"]>>()
      .mockResolvedValueOnce({ confirmModel: "Costs 5x more. Pin it?" })
      .mockResolvedValueOnce(undefined);
    mount(
      actions({ updateAgent }),
      data({ modelChoices: ["Sonnet 5", "Haiku 5", "Opus 5.5"] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Haiku 5" }));
    });
    expect(screen.getByText("Costs 5x more. Pin it?")).toBeTruthy();
    /* Picking a different model supersedes the held prompt — it must not
       still offer to pin the superseded pick. */
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Opus 5.5" }));
    });
    expect(screen.queryByText("Costs 5x more. Pin it?")).toBeNull();
    expect(updateAgent).toHaveBeenLastCalledWith("emp_1", {
      model: "Opus 5.5",
    });
  });

  test("a failed save says why beside the field", async () => {
    const updateAgent = vi.fn().mockRejectedValue(new Error("engine down"));
    mount(actions({ updateAgent }));
    fireEvent.click(screen.getByRole("button", { name: "Reads every diff" }));
    const box = screen.getByLabelText("Description");
    fireEvent.change(box, { target: { value: "Ships PRs" } });
    await act(async () => {
      fireEvent.blur(box);
    });
    expect(screen.getByText(/Couldn't save — engine down/)).toBeTruthy();
    // What you typed is not lost — the text stays the app's record of it.
    expect(
      screen.getByRole("button", { name: "Reads every diff" }),
    ).toBeTruthy();
  });
});

describe("runs on its own runtime", () => {
  /* A Devin agent's page (#872): no internals rows at all — no "Runs
     on", no "Profile", no hired date, no "Now" — the Model menu is
     Devin's own list, never Hermes's, and the avatar is the runtime's
     mark. */
  const devinAgent: V3Agent = {
    ...agent,
    id: "emp_devin",
    name: "Coder",
    runtime: "acp:devin",
    profile: "devin",
    model: "SWE-2 · High",
  };

  test("no Runs on or Profile row, Devin's own models", async () => {
    const act_ = actions();
    const { container } = render(
      <V3AgentPage
        data={data({ agents: [devinAgent, other], runtimes: [HERMES, DEVIN] })}
        go={vi.fn()}
        act={act_}
        id="emp_devin"
      />,
    );
    expect(screen.queryByText("Runs on")).toBeNull();
    expect(screen.queryByText("Profile")).toBeNull();
    expect(screen.queryByText("acp:devin")).toBeNull();
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.queryByText(/hired /)).toBeNull();
    // The runtime's letter and tone, not the agent's own (#872).
    const face = container.querySelector("span[aria-hidden]");
    expect(face?.textContent).toBe("D");
    expect(face?.className).toContain("bg-[#e5eef5]");

    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    expect(
      screen.getByRole("menuitemradio", { name: "SWE-2 · Medium" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitemradio", { name: "Sonnet 5" }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitemradio", { name: "SWE-2 · Medium" }),
      );
    });
    expect(act_.updateAgent).toHaveBeenCalledWith("emp_devin", {
      model: "SWE-2 · Medium",
    });
  });

  test("a Hermes agent's page keeps internals off too", () => {
    render(
      <V3AgentPage
        data={data({ agents: two, runtimes: [HERMES, DEVIN] })}
        go={vi.fn()}
        act={actions()}
        id="emp_1"
      />,
    );
    expect(screen.queryByText("Runs on")).toBeNull();
    expect(screen.queryByText("Profile")).toBeNull();
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(screen.queryByText(/hired /)).toBeNull();
    // …while the things a person edits are all there.
    expect(
      screen.getByRole("button", { name: "Reads every diff" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Instructions")).toBeTruthy();
  });

  test("a field the runtime can't write is text; instructions say why", () => {
    render(
      <V3AgentPage
        data={data({
          agents: [devinAgent, other],
          runtimes: [HERMES, { ...DEVIN, updatable: ["name", "model"] }],
        })}
        go={vi.fn()}
        act={actions()}
        id="emp_devin"
      />,
    );
    expect(screen.getByText("Reads every diff")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Reads every diff" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    expect(screen.getByText("LilOS can't change these on Devin")).toBeTruthy();
  });

  test("an unavailable runtime's schedules read greyed with the reason", () => {
    render(
      <V3AgentPage
        data={data({
          agents: [{ ...devinAgent, runtime: "acp:cursor" }, other],
          runtimes: [
            HERMES,
            DEVIN,
            {
              id: "acp:cursor",
              label: "Cursor",
              available: false,
              detail: "cursor-agent is not on PATH",
            },
          ],
        })}
        go={vi.fn()}
        act={actions()}
        id="emp_devin"
      />,
    );
    expect(screen.getByText(/Can't run right now/)).toBeTruthy();
    expect(screen.queryByText("New schedule")).toBeNull();
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
    expect(ask.textContent).toContain("you can add it back any time");
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
