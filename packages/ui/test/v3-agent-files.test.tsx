// @vitest-environment happy-dom
/* An agent's notes and skills, and the company skill library. A section is
   drawn only when its records and its handler were both passed (D-#19): the
   real app passes neither, so these tests pin that absence as well as the
   prototype's edit, attach and add. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { V3AgentPage } from "../src/v3/v3-agent";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3Settings } from "../src/v3/v3-settings";
import type { V3Agent, V3Note, V3Skill } from "../src/v3/v3-types";

afterEach(cleanup);

const notes: V3Note[] = [
  {
    id: "readers",
    name: "readers.md",
    text: "They journal at night.",
    updated: "14 Oct",
  },
];

const skills: V3Skill[] = [
  {
    id: "web-research",
    name: "web-research",
    about: "A sheet, with a source on every row.",
    text: "Cite every row.",
  },
  {
    id: "sheets",
    name: "sheets",
    about: "One row per fact.",
    text: "A cell is a value.",
  },
];

const agent: V3Agent = {
  id: "scout",
  name: "Scout",
  tone: "s",
  role: "Researcher",
  hired: "2 Oct",
  model: "Sonnet 5",
  instructions: ["Return a sheet, never a wall of text."],
  skills: ["web-research"],
  notes,
};

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    company: "Co",
    me: "Ada",
    today: "Monday",
    agents: [agent],
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
    agentFields: ["instructions"],
    settings: {
      approvals: "ask",
      models: [],
      engine: { name: "Hermes", state: "ok" },
      relay: { state: "ok" },
    },
    setUp: true,
    features: { tickets: false },
    ...over,
  }) as V3Data;

const actions = (over: Partial<V3Actions> = {}): V3Actions =>
  ({
    updateAgent: vi.fn(async () => undefined),
    saveNote: vi.fn(),
    setAgentSkill: vi.fn(),
    addSkill: vi.fn(),
    ask: vi.fn(),
    saveSettings: vi.fn(),
    scheduleSave: vi.fn(),
    scheduleToggle: vi.fn(),
    scheduleRunNow: vi.fn(),
    scheduleDelete: vi.fn(),
    ...over,
  }) as unknown as V3Actions;

const notesOf = () =>
  within(document.querySelector("[data-agent-notes]") as HTMLElement);

describe("gated off without records and handlers", () => {
  test("the real app's shape: instructions stay, notes and skill toggles do not", () => {
    const plain: V3Agent = { ...agent, notes: undefined, skills: undefined };
    render(
      <V3AgentPage
        data={data({ agents: [plain], skills: undefined })}
        go={vi.fn()}
        act={actions({
          saveNote: undefined,
          setAgentSkill: undefined,
          addSkill: undefined,
        })}
        id="scout"
      />,
    );
    expect(
      screen.getByText("Return a sheet, never a wall of text."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Notes/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Using" })).toBeNull();
  });

  test("notes without a save are not drawn", () => {
    render(
      <V3AgentPage
        data={data()}
        go={vi.fn()}
        act={actions({ saveNote: undefined })}
        id="scout"
      />,
    );
    expect(screen.queryByRole("heading", { name: /^Notes/ })).toBeNull();
  });

  test("skill names stay a quiet list when the library cannot be changed", () => {
    render(
      <V3AgentPage
        data={data({ skills: undefined })}
        go={vi.fn()}
        act={actions({ setAgentSkill: undefined })}
        id="scout"
      />,
    );
    expect(screen.getByText("web-research")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "web-research" })).toBeNull();
  });

  test("Settings has no Skills tab unless the library and add are both passed", () => {
    const { rerender } = render(
      <V3Settings
        data={data()}
        go={vi.fn()}
        act={actions({ addSkill: undefined })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
    rerender(
      <V3Settings
        data={data({ skills })}
        go={vi.fn()}
        act={actions({ addSkill: undefined })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
  });
});

describe("notes", () => {
  test("opens a file, edits it, and saves that file", () => {
    const act_ = actions();
    render(<V3AgentPage data={data()} go={vi.fn()} act={act_} id="scout" />);
    const region = notesOf();
    fireEvent.click(region.getByRole("button", { name: /readers\.md/ }));
    expect(region.getByText("They journal at night.")).toBeTruthy();
    fireEvent.click(region.getByRole("button", { name: "Edit" }));
    fireEvent.change(region.getByLabelText("Note"), {
      target: { value: "They journal after 21:00." },
    });
    fireEvent.click(region.getByRole("button", { name: "Save" }));
    expect(act_.saveNote).toHaveBeenCalledWith("scout", {
      id: "readers",
      name: "readers.md",
      text: "They journal after 21:00.",
    });
  });

  test("a new note is a new file, and a taken or path name is not saved", () => {
    const act_ = actions();
    render(<V3AgentPage data={data()} go={vi.fn()} act={act_} id="scout" />);
    const region = notesOf();
    fireEvent.click(region.getByRole("button", { name: "New note" }));
    fireEvent.change(region.getByLabelText("File name"), {
      target: { value: "readers.md" },
    });
    fireEvent.change(region.getByLabelText("Note"), {
      target: { value: "again" },
    });
    fireEvent.click(region.getByRole("button", { name: "Save" }));
    expect(region.getByText("A note already has that name.")).toBeTruthy();
    expect(act_.saveNote).not.toHaveBeenCalled();

    fireEvent.change(region.getByLabelText("File name"), {
      target: { value: "notes/extra.md" },
    });
    fireEvent.click(region.getByRole("button", { name: "Save" }));
    expect(
      region.getByText("A note is one file name, not a path."),
    ).toBeTruthy();

    fireEvent.change(region.getByLabelText("File name"), {
      target: { value: "sources.md" },
    });
    fireEvent.click(region.getByRole("button", { name: "Save" }));
    expect(act_.saveNote).toHaveBeenCalledWith("scout", {
      name: "sources.md",
      text: "again",
    });
  });
});

describe("skills", () => {
  test("attach and detach call the handler, and Library opens Settings", () => {
    const act_ = actions();
    const go = vi.fn();
    render(
      <V3AgentPage data={data({ skills })} go={go} act={act_} id="scout" />,
    );
    const using = within(screen.getByRole("group", { name: "Using" }));
    expect(
      using.getByRole("button", { name: "web-research", pressed: true }),
    ).toBeTruthy();
    fireEvent.click(using.getByRole("button", { name: "web-research" }));
    expect(act_.setAgentSkill).toHaveBeenCalledWith(
      "scout",
      "web-research",
      false,
    );
    const rest = within(screen.getByRole("group", { name: "Not using" }));
    fireEvent.click(rest.getByRole("button", { name: "sheets" }));
    expect(act_.setAgentSkill).toHaveBeenCalledWith("scout", "sheets", true);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(go).toHaveBeenCalledWith({ page: "settings", view: "skills" });
  });

  test("instructions stay the existing field beside the new sections", () => {
    render(
      <V3AgentPage
        data={data({ skills })}
        go={vi.fn()}
        act={actions()}
        id="scout"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Instructions")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Notes/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Using" })).toBeTruthy();
  });
});

describe("skill library", () => {
  const library = (act_: V3Actions, go = vi.fn()) =>
    render(
      <V3Settings data={data({ skills })} go={go} act={act_} view="skills" />,
    );

  test("lists skills and shows the one you open", () => {
    library(actions());
    expect(screen.getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText("Choose a skill.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /web-research/ }));
    const view = document.querySelector("[data-skill-view]") as HTMLElement;
    expect(within(view).getByText("Cite every row.")).toBeTruthy();
  });

  test("adds from typed text", () => {
    const act_ = actions();
    library(act_);
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "launch checklist" },
    });
    fireEvent.change(screen.getByLabelText("Skill text"), {
      target: { value: "Ask before anything public." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(act_.addSkill).toHaveBeenCalledWith({
      name: "launch checklist",
      about: "Ask before anything public.",
      text: "Ask before anything public.",
    });
  });

  test("a text file fills the name, the line, and the text", async () => {
    library(actions());
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    const file = new File(
      ["# Launch\nAsk before anything public.\n"],
      "launch-notes.md",
      { type: "text/markdown" },
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Skill file"), {
        target: { files: [file] },
      });
    });
    expect(await screen.findByDisplayValue("launch notes")).toBeTruthy();
    expect(screen.getByLabelText("Skill text")).toHaveProperty(
      "value",
      "# Launch\nAsk before anything public.\n",
    );
    expect((screen.getByLabelText("About") as HTMLInputElement).value).toBe(
      "Ask before anything public.",
    );
  });
});
