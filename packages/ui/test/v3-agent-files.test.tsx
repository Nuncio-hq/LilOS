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
    text: "They journal at night.\n\n# Night\n\n- After 21:00.",
    updated: "from HB-9",
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
  test("one memory list: the row is the file, its first line, and where it came from", () => {
    render(
      <V3AgentPage data={data()} go={vi.fn()} act={actions()} id="scout" />,
    );
    expect(screen.getAllByRole("heading", { name: /^Notes/ })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: /Remembers/ })).toBeNull();
    expect(screen.queryByText("Remembers")).toBeNull();
    const row = notesOf().getByRole("button", { name: /readers\.md/ });
    expect(row.textContent).toContain("They journal at night.");
    expect(row.textContent).toContain("from HB-9");
  });

  test("the open note keeps the selected row mark without a hover, and renders markdown", () => {
    render(
      <V3AgentPage data={data()} go={vi.fn()} act={actions()} id="scout" />,
    );
    const region = notesOf();
    const row = region.getByRole("button", { name: /readers\.md/ });
    fireEvent.click(row);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("shadow-[inset_2px_0_0_var(--foreground)]");
    const article = region.getByRole("article");
    expect(
      within(article).getByRole("heading", { name: "Night" }),
    ).toBeTruthy();
    expect(article.textContent).not.toContain("# Night");
  });

  test("opens a file, edits it, and saves that file inside its own panel", () => {
    const act_ = actions();
    render(<V3AgentPage data={data()} go={vi.fn()} act={act_} id="scout" />);
    const region = notesOf();
    fireEvent.click(region.getByRole("button", { name: /readers\.md/ }));
    expect(
      region.getAllByText("They journal at night.").length,
    ).toBeGreaterThan(0);
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
    expect(document.querySelector("[data-toast]")).toBeNull();
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

const chipNames = () =>
  within(screen.getByRole("group", { name: "Using" }))
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"))
    .filter((n) => n?.startsWith("Detach"));

describe("skills", () => {
  test("using chips stay in attach order; Add skill attaches, the chip detaches", () => {
    const act_ = actions();
    const go = vi.fn();
    const research = skills[0];
    const sheetsSkill = skills[1];
    if (!research || !sheetsSkill) throw new Error("fixture");
    const library: V3Skill[] = [
      research,
      {
        id: "brand-voice",
        name: "brand-voice",
        about: "Plain words.",
        text: "Plain.",
      },
      sheetsSkill,
    ];
    const scout: V3Agent = {
      ...agent,
      skills: ["sheets", "web-research"],
    };
    const view = (who: V3Agent) => data({ agents: [who], skills: library });
    const { rerender } = render(
      <V3AgentPage data={view(scout)} go={go} act={act_} id="scout" />,
    );
    expect(screen.queryByText("Not using")).toBeNull();
    expect(chipNames()).toEqual(["Detach sheets", "Detach web-research"]);
    fireEvent.click(screen.getByRole("button", { name: "+ Add skill" }));
    const menu = screen.getByRole("menu", { name: "Add a skill" });
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.className).toContain("max-h-");
    expect(menu.className).toContain("top-full");
    expect(menu.getAttribute("data-menu-place")).toBe("down");
    expect(within(menu).queryByRole("menuitem", { name: /sheets/ })).toBeNull();
    fireEvent.change(within(menu).getByLabelText("Find a skill"), {
      target: { value: "brand" },
    });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: /brand-voice/ }),
    );
    expect(act_.setAgentSkill).toHaveBeenCalledWith(
      "scout",
      "brand-voice",
      true,
    );
    rerender(
      <V3AgentPage
        data={view({
          ...scout,
          skills: ["sheets", "web-research", "brand-voice"],
        })}
        go={go}
        act={act_}
        id="scout"
      />,
    );
    expect(chipNames()).toEqual([
      "Detach sheets",
      "Detach web-research",
      "Detach brand-voice",
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Detach web-research" }),
    );
    expect(act_.setAgentSkill).toHaveBeenCalledWith(
      "scout",
      "web-research",
      false,
    );
    rerender(
      <V3AgentPage
        data={view({
          ...scout,
          skills: ["sheets", "brand-voice"],
        })}
        go={go}
        act={act_}
        id="scout"
      />,
    );
    expect(chipNames()).toEqual(["Detach sheets", "Detach brand-voice"]);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(go).toHaveBeenCalledWith({ page: "settings", view: "skills" });
  });

  test("the menu scrolls, and opens upward when the button is near the bottom", () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    const height = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute("aria-haspopup") === "menu") {
        return {
          x: 0,
          y: 860,
          top: 860,
          bottom: 884,
          left: 0,
          right: 80,
          width: 80,
          height: 24,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      return real.call(this);
    };
    try {
      render(
        <V3AgentPage
          data={data({ skills })}
          go={vi.fn()}
          act={actions()}
          id="scout"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "+ Add skill" }));
      const menu = screen.getByRole("menu", { name: "Add a skill" });
      expect(menu.className).toContain("overflow-y-auto");
      expect(menu.className).toContain("max-h-");
      expect(menu.className).toContain("bottom-full");
      expect(menu.getAttribute("data-menu-place")).toBe("up");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: height,
      });
    }
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

  test("the list scrolls on its own, the detail stays, and the open row stays marked", () => {
    library(actions());
    expect(screen.getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(screen.getByLabelText("Filter skills")).toBeTruthy();
    expect(document.querySelector("[data-skill-list]")?.className).toContain(
      "overflow-y-auto",
    );
    expect(document.querySelector("[data-skill-detail]")?.className).toContain(
      "sticky",
    );
    expect(screen.getByText("Choose a skill.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter skills"), {
      target: { value: "per fact" },
    });
    expect(screen.queryByRole("button", { name: /web-research/ })).toBeNull();
    const row = screen.getByRole("button", { name: /sheets/ });
    fireEvent.click(row);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("shadow-[inset_2px_0_0_var(--foreground)]");
    const view = document.querySelector("[data-skill-view]") as HTMLElement;
    expect(within(view).getByText("A cell is a value.")).toBeTruthy();
  });

  test("the add form replaces the detail", () => {
    library(actions());
    fireEvent.click(screen.getByRole("button", { name: /web-research/ }));
    expect(screen.getByText("Cite every row.")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add skill" });
    fireEvent.click(add);
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(add.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(document.querySelector("[data-add-skill]")).toBeTruthy();
    expect(document.querySelector("[data-skill-view]")).toBeNull();
    expect(screen.queryByText("Cite every row.")).toBeNull();
  });

  test("adds from typed text under the slug the form shows", () => {
    const act_ = actions();
    library(act_);
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Launch Notes" },
    });
    expect(document.querySelector("[data-skill-slug]")?.textContent).toBe(
      "launch-notes",
    );
    fireEvent.change(screen.getByLabelText("Skill text"), {
      target: { value: "Ask before anything public." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(act_.addSkill).toHaveBeenCalledWith({
      name: "launch-notes",
      about: "Ask before anything public.",
      text: "",
    });
  });

  test("a name the library already has is refused, and a name with no letters says so", () => {
    const act_ = actions();
    library(act_);
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Éclair & Tea!" },
    });
    expect(document.querySelector("[data-skill-slug]")?.textContent).toBe(
      "eclair-tea",
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "web-research" },
    });
    fireEvent.change(screen.getByLabelText("Skill text"), {
      target: { value: "Again." },
    });
    expect(screen.getByText("A skill already has that name.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add", exact: true }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(act_.addSkill).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "!!!" },
    });
    expect(screen.getByText("Use letters or numbers.")).toBeTruthy();
    expect(document.querySelector("[data-skill-slug]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add", exact: true }),
    ).toHaveProperty("disabled", true);
  });

  test("adding selects the new skill and renders its markdown", () => {
    const act_ = actions();
    const { rerender } = render(
      <V3Settings
        data={data({ skills })}
        go={vi.fn()}
        act={act_}
        view="skills"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Launch Notes" },
    });
    fireEvent.change(screen.getByLabelText("Skill text"), {
      target: { value: "# Launch\nAsk before anything public." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(act_.addSkill).toHaveBeenCalledWith({
      name: "launch-notes",
      about: "Ask before anything public.",
      text: "# Launch",
    });
    const added: V3Skill = {
      id: "launch-notes",
      name: "launch-notes",
      about: "Ask before anything public.",
      text: "# Launch\nAsk before anything public.",
    };
    rerender(
      <V3Settings
        data={data({ skills: [...skills, added] })}
        go={vi.fn()}
        act={act_}
        view="skills"
      />,
    );
    const row = screen.getByRole("button", { name: /launch-notes/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    const view = document.querySelector("[data-skill-view]") as HTMLElement;
    expect(within(view).getByRole("heading", { name: "Launch" })).toBeTruthy();
    expect(view.textContent).not.toContain("# Launch");
    expect(view.textContent?.split("Ask before anything public.").length).toBe(
      2,
    );
  });

  test("a text file fills the kebab-case name, the line, and the text", async () => {
    library(actions());
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    const file = new File(
      ["# Launch\nAsk before anything public.\n\nWarm the cups.\n"],
      "launch-notes.md",
      { type: "text/markdown" },
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Skill file"), {
        target: { files: [file] },
      });
    });
    expect(await screen.findByDisplayValue("launch-notes")).toBeTruthy();
    // The name already is the slug; the form doesn't say it twice.
    expect(document.querySelector("[data-skill-slug]")).toBeNull();
    const body = screen.getByLabelText("Skill text") as HTMLTextAreaElement;
    expect(body.value).toBe("# Launch\n\nWarm the cups.");
    expect(body.value).not.toContain("Ask before anything public.");
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("Ask before anything public.");
  });

  test("a file's frontmatter is the name and the description", async () => {
    library(actions());
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    const file = new File(
      [
        "---\nname: Éclair & Tea!\ndescription: A pot for the afternoon.\n---\n\n# Serve\n\nWarm the pot.\n",
      ],
      "tea.md",
      { type: "text/markdown" },
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Skill file"), {
        target: { files: [file] },
      });
    });
    expect(await screen.findByDisplayValue("eclair-tea")).toBeTruthy();
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).value,
    ).toBe("A pot for the afternoon.");
    const body = screen.getByLabelText("Skill text") as HTMLTextAreaElement;
    expect(body.value).toContain("# Serve");
    expect(body.value).toContain("Warm the pot.");
    expect(body.value).not.toContain("A pot for the afternoon.");
  });
});
