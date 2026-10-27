// @vitest-environment happy-dom
/* Projects in the v3 UI (D-#771): a thread is in a project or a plain chat.
   - the new chat's Project chip always shows: projects, "No project · just
     chat", and (where the app can) "New project from a folder…"; it sends the
     picked project's folder, and nothing for a plain chat;
   - the next chat starts where the last one did, a plain chat included;
   - a project's page lists its threads by status without tickets (#887);
   - the trail and the rows name the project a thread lives in. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3DraftChat } from "../src/v3/v3-draft-chat";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3Peek } from "../src/v3/v3-peek";
import { V3ProjectPage } from "../src/v3/v3-project";
import type {
  V3Agent,
  V3Project,
  V3Status,
  V3Thread,
} from "../src/v3/v3-types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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

const APP: V3Project = {
  id: "p_app",
  name: "App",
  key: "APP",
  tone: "b",
  folder: "/repo/app",
  about: "",
};
const WEB: V3Project = {
  id: "p_web",
  name: "Web",
  key: "WEB",
  tone: "r",
  folder: "/repo/web",
  about: "",
};

const thread = (
  id: string,
  status: V3Status,
  over: Partial<V3Thread> = {},
): V3Thread => ({
  id,
  agentId: "emp_1",
  title: `Title ${id}`,
  status,
  startedAt: "10:00",
  minutes: 3,
  turns: [],
  ...over,
});

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
    ask: vi.fn(),
    startChat: vi.fn(async () => "conv_new"),
    ...over,
  }) as unknown as V3Actions;

const chip = () => screen.getByTitle(/^Project · /);
async function open(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function send(text: string) {
  const box = screen.getByLabelText(/^Message Reviewer/);
  await act(async () => {
    fireEvent.change(box, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
}

describe("the new chat's Project chip", () => {
  test("with no project yet it still offers just chat, and a new project where the app can", async () => {
    const newProject = vi.fn();
    render(
      <V3DraftChat
        data={data()}
        go={vi.fn()}
        act={actions({ newProject })}
        id="emp_1"
      />,
    );
    expect(chip().textContent).toContain("No project");
    await open(chip());
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("menuitemradio", {
        name: /No project · just chat/,
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "New project from a folder…",
      }),
    );
    expect(newProject).toHaveBeenCalledTimes(1);
  });

  test("without a way to make a project there is no such row, and never a Folder chip", async () => {
    render(
      <V3DraftChat
        data={data({ projects: [APP] })}
        go={vi.fn()}
        act={actions()}
        id="emp_1"
      />,
    );
    expect(screen.queryByTitle(/^Folder · /)).toBeNull();
    await open(chip());
    expect(screen.queryByRole("menuitem", { name: /New project/ })).toBeNull();
  });

  test("the project made from a folder is picked once it exists", async () => {
    let created: (id: string) => void = () => {};
    const newProject = vi.fn((onCreated: (id: string) => void) => {
      created = onCreated;
    });
    const view = render(
      <V3DraftChat
        data={data()}
        go={vi.fn()}
        act={actions({ newProject })}
        id="emp_1"
      />,
    );
    await open(chip());
    fireEvent.click(
      screen.getByRole("menuitem", { name: "New project from a folder…" }),
    );
    // The app's relay answers: the project is in the data, then it is picked.
    view.rerender(
      <V3DraftChat
        data={data({ projects: [APP] })}
        go={vi.fn()}
        act={actions({ newProject })}
        id="emp_1"
      />,
    );
    await act(async () => created("p_app"));
    expect(chip().textContent).toContain("App");
    expect(chip().getAttribute("title")).toBe("Project · /repo/app");
  });

  test("a picked project sends its folder; no project sends none", async () => {
    const startChat = vi.fn(async () => "conv_new");
    render(
      <V3DraftChat
        data={data({ projects: [APP, WEB] })}
        go={vi.fn()}
        act={actions({ startChat })}
        id="emp_1"
      />,
    );
    // No chat yet: it starts on the first project.
    expect(chip().textContent).toContain("App");
    await open(chip());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Web/ }));
    await send("hello");
    expect(startChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: "emp_1",
        projectId: "p_web",
        folder: "/repo/web",
        text: "hello",
      }),
    );

    await open(chip());
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /No project · just chat/ }),
    );
    await send("just talking");
    const last = startChat.mock.calls.at(-1) as unknown as [
      Record<string, unknown>,
    ];
    expect(last[0].text).toBe("just talking");
    expect(last[0].projectId).toBeUndefined();
    expect(last[0].folder).toBeUndefined();
  });

  test("a sent draft becomes its thread where the draft was", async () => {
    const go = vi.fn();
    render(
      <V3DraftChat
        data={data({ projects: [APP] })}
        go={go}
        act={actions()}
        id="emp_1"
      />,
    );
    await send("hello");
    expect(go).toHaveBeenCalledWith({ page: "thread", id: "conv_new" });
  });

  test("the next chat starts where the last one did, a plain chat included", () => {
    const withLast = (lastChat: V3Agent["lastChat"]) =>
      data({
        projects: [APP, WEB],
        agents: [{ ...agent, lastChat }],
      });
    const draft = (d: V3Data) => (
      <V3DraftChat data={d} go={vi.fn()} act={actions()} id="emp_1" />
    );
    const view = render(draft(withLast({ projectId: "p_web" })));
    expect(chip().textContent).toContain("Web");
    view.rerender(draft(withLast({ opener: "just talking" })));
    expect(chip().textContent).toContain("No project");
    expect(chip().getAttribute("title")).toBe("Project · none");
  });
});

describe("a project's page", () => {
  const props = (d: V3Data) => ({
    data: d,
    go: vi.fn(),
    act: actions(),
    id: "p_app",
  });

  test("lists its threads by status, and nothing from another project", () => {
    const d = data({
      projects: [APP, WEB],
      threads: [
        thread("run", "working", { projectId: "p_app" }),
        thread("old", "done", { projectId: "p_app" }),
        thread("other", "working", { projectId: "p_web" }),
        thread("plain", "done"),
      ],
      archivedThreads: [thread("parked", "done", { projectId: "p_app" })],
    });
    render(<V3ProjectPage {...props(d)} />);
    const box = document.querySelector("[data-project-threads]") as HTMLElement;
    /* Active reads off the list — a finished-but-listed thread sits there
       (#887); Working and Done fold away. */
    expect(within(box).getByText("Title old")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Working \(1\)/ }));
    expect(within(box).getByText("Title run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/ }));
    expect(within(box).getByText("Title parked")).toBeTruthy();
    expect(within(box).queryByText("Title other")).toBeNull();
    expect(within(box).queryByText("Title plain")).toBeNull();
    // The page is the project: its rows do not repeat the name.
    expect(box.textContent).not.toContain("App");
    expect(screen.getByText("/repo/app")).toBeTruthy();
  });

  test("without tickets there is no ticket or goal copy, and Agents on it follows the threads", () => {
    const d = data({
      projects: [APP],
      threads: [thread("run", "working", { projectId: "p_app" })],
    });
    render(<V3ProjectPage {...props(d)} />);
    expect(document.body.textContent).not.toMatch(/\b(tickets?|goals?)\b/i);
    const on = screen.getByText("Agents on it").parentElement as HTMLElement;
    expect(within(on).getByText("Reviewer")).toBeTruthy();
  });

  test("a long Done is cut, and Show all brings the rest", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      thread(`t${i}`, "done", { projectId: "p_app" }),
    );
    render(
      <V3ProjectPage
        {...props(data({ projects: [APP], archivedThreads: many }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Done \(15\)/ }));
    expect(screen.getAllByText(/^Title t/)).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: /Show all 15/ }));
    expect(screen.getAllByText(/^Title t/)).toHaveLength(15);
  });

  test("an unknown project says so", () => {
    render(<V3ProjectPage {...props(data())} />);
    expect(screen.getByText("Project not found.")).toBeTruthy();
  });
});

describe("the trail says what a thread is filed under", () => {
  const trail = (d: V3Data, id: string) => {
    render(
      <V3Peek
        data={d}
        go={vi.fn()}
        act={actions()}
        trail={[{ page: "thread", id }]}
        full={false}
        pageName="Threads"
        onBack={vi.fn()}
        onTrail={vi.fn()}
        onFull={vi.fn()}
        onClose={vi.fn()}
        renderThread={() => null}
      />,
    );
    return screen.getByRole("navigation", { name: "Trail" }).textContent;
  };
  const d = data({
    projects: [APP],
    threads: [
      thread("in", "done", { projectId: "p_app" }),
      thread("plain", "done"),
      thread("tk", "done", { ticketId: "APP-1", projectId: "p_app" }),
    ],
  });

  test("a project thread names its project", () => {
    expect(trail(d, "in")).toBe("ThreadsReviewer · App");
  });

  test("a plain chat says Chat", () => {
    expect(trail(d, "plain")).toBe("ThreadsReviewer · Chat");
  });

  test("a ticket's hand keeps its ticket", () => {
    expect(trail(d, "tk")).toBe("ThreadsReviewer · APP-1");
  });
});
