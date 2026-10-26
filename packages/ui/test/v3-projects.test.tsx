// @vitest-environment happy-dom
/* Projects in the v3 UI (D-#771): a thread is in a project or a plain chat.
   - the new chat's Project chip always shows: projects, "No project · just
     chat", and (where the app can) "New project from a folder…"; it sends the
     picked project's folder, and nothing for a plain chat;
   - the next chat starts where the last one did, a plain chat included;
   - a project's page lists its live and past threads without tickets;
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
import { AddFolderDialog } from "../src/dialogs/add-folder-dialog";
import { ThreadView } from "../src/thread/thread-view";
import type { Channel, EmpFn, HumanFn, Msg, Thread } from "../src/types";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3DraftChat } from "../src/v3/v3-draft-chat";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3Peek } from "../src/v3/v3-peek";
import { V3ProjectPage } from "../src/v3/v3-project";
import { V3Sidebar } from "../src/v3/v3-sidebar";
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

  test("lists its live and its past threads, and nothing from another project", () => {
    const d = data({
      projects: [APP, WEB],
      threads: [
        thread("run", "working", { projectId: "p_app" }),
        thread("old", "done", { projectId: "p_app" }),
        thread("other", "working", { projectId: "p_web" }),
        thread("plain", "done"),
      ],
    });
    render(<V3ProjectPage {...props(d)} />);
    const live = document.querySelector("[data-project-live]") as HTMLElement;
    const past = document.querySelector("[data-project-past]") as HTMLElement;
    expect(within(live).getByText("Title run")).toBeTruthy();
    expect(within(past).getByText("Title old")).toBeTruthy();
    expect(screen.queryByText("Title other")).toBeNull();
    expect(screen.queryByText("Title plain")).toBeNull();
    // The page is the project: its rows do not repeat the name.
    expect(live.textContent).not.toContain("App");
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

  test("a long past is cut, and Show all brings the rest", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      thread(`t${i}`, "done", { projectId: "p_app" }),
    );
    render(
      <V3ProjectPage {...props(data({ projects: [APP], threads: many }))} />,
    );
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

/* #854: projects are added by hand. A folder alone makes no project — a
   thread opened in one files under Chats with its folder named; a folder
   inside a project's folder belongs to that project; adding and removing a
   project never touch the folder or the threads. */
describe("projects by hand (#854)", () => {
  const props = (d: V3Data, act: V3Actions = actions()) => ({
    data: d,
    go: vi.fn(),
    act,
    id: "p_app",
  });

  test("a thread's folder inside a project's folder files it under the project", () => {
    const d = data({
      projects: [APP],
      threads: [
        thread("wt", "done", { folder: "/repo/app/.lilos/wt/ac-1" }),
        thread("chat", "done", { folder: "/repo/other" }),
      ],
    });
    render(<V3ProjectPage {...props(d)} />);
    const past = document.querySelector("[data-project-past]") as HTMLElement;
    expect(within(past).getByText("Title wt")).toBeTruthy();
    expect(screen.queryByText("Title chat")).toBeNull();
  });

  test("a folder chat is tagged Chat with its folder's name, on the trail too", () => {
    const d = data({
      threads: [thread("c", "done", { folder: "/repo/notes" })],
    });
    render(
      <V3Peek
        data={d}
        go={vi.fn()}
        act={actions()}
        trail={[{ page: "thread", id: "c" }]}
        full={false}
        pageName="Threads"
        onBack={vi.fn()}
        onTrail={vi.fn()}
        onFull={vi.fn()}
        onClose={vi.fn()}
        renderThread={() => null}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Trail" }).textContent).toBe(
      "ThreadsReviewer · Chat · notes",
    );
  });

  test("Remove project says the folder and threads stay, then removes", async () => {
    const removeProject = vi.fn(async () => {});
    const go = vi.fn();
    const d = data({ projects: [APP] });
    render(
      <V3ProjectPage
        data={d}
        go={go}
        act={actions({ removeProject })}
        id="p_app"
      />,
    );
    const group = document.querySelector(
      "[data-remove-project]",
    ) as HTMLElement;
    fireEvent.click(
      within(group).getByRole("button", { name: "Remove project" }),
    );
    // The confirm names the kept things — the folder and every thread.
    expect(group.textContent).toContain("the folder");
    expect(group.textContent).toContain("/repo/app");
    expect(group.textContent).toContain("become chats again");
    await act(async () => {
      fireEvent.click(
        within(group).getByRole("button", { name: "Remove project" }),
      );
    });
    expect(removeProject).toHaveBeenCalledWith("p_app");
    expect(go).toHaveBeenCalledWith({ page: "home" });
  });

  test("Cancel closes the confirm; without the action there is no Remove", async () => {
    const removeProject = vi.fn(async () => {});
    render(
      <V3ProjectPage
        data={data({ projects: [APP] })}
        go={vi.fn()}
        act={actions({ removeProject })}
        id="p_app"
      />,
    );
    const group = document.querySelector(
      "[data-remove-project]",
    ) as HTMLElement;
    fireEvent.click(
      within(group).getByRole("button", { name: "Remove project" }),
    );
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(within(group).getByRole("button", { name: "Remove project" }));
    expect(removeProject).not.toHaveBeenCalled();
    cleanup();
    render(
      <V3ProjectPage
        data={data({ projects: [APP] })}
        go={vi.fn()}
        act={actions()}
        id="p_app"
      />,
    );
    expect(document.querySelector("[data-remove-project]")).toBeNull();
  });

  test("the + beside Projects asks for a folder; without the action there is no +", () => {
    const onNewProject = vi.fn();
    const sidebar = (extra: object) => (
      <V3Sidebar
        data={data({ projects: [APP] })}
        page={{ page: "home" }}
        go={vi.fn()}
        onSearch={vi.fn()}
        dark={false}
        onTheme={vi.fn()}
        mode="docked"
        width={260}
        sideRef={{ current: null }}
        onToggle={vi.fn()}
        onPointerEnter={vi.fn()}
        onPointerLeave={vi.fn()}
        onBlur={vi.fn()}
        {...extra}
      />
    );
    render(sidebar({ onNewProject }));
    const plus = document.querySelector("[data-new-project]") as HTMLElement;
    expect(plus).toBeTruthy();
    fireEvent.click(plus);
    expect(onNewProject).toHaveBeenCalledTimes(1);
    cleanup();
    render(sidebar({}));
    expect(document.querySelector("[data-new-project]")).toBeNull();
  });

  test("the folder picker's project fields prefill from the folder and stay editable", async () => {
    const onAdd = vi.fn();
    const r = render(
      <AddFolderDialog
        folders={[]}
        fs={{
          "~": { children: ["journal-app"] },
          "~/journal-app": { children: [] },
        }}
        discovered={[]}
        onClose={() => {}}
        onAdd={onAdd}
        projectFields
      />,
    );
    expect(r.container.querySelector("[data-projectname]")).toBeNull();
    fireEvent.click(r.container.querySelector('[data-fsrow="journal-app"]')!);
    const name = r.container.querySelector(
      "[data-projectname]",
    ) as HTMLInputElement;
    const key = r.container.querySelector(
      "[data-projectkey]",
    ) as HTMLInputElement;
    expect(name.value).toBe("journal-app");
    expect(key.value).toBe("JOU");
    // Both stay editable — the suggestion is a start, not a lock.
    fireEvent.change(name, { target: { value: "My journal" } });
    fireEvent.change(key, { target: { value: "mj" } });
    expect(key.value).toBe("MJ");
    fireEvent.click(r.container.querySelector("[data-addbtn]")!);
    expect(onAdd).toHaveBeenCalledWith("~/journal-app", {
      name: "My journal",
      key: "MJ",
    });
    // Without projectFields nothing in the dialog asks for a name or key.
    cleanup();
    const plain = render(
      <AddFolderDialog
        folders={[]}
        fs={{ "~": { children: ["x"] }, "~/x": { children: [] } }}
        discovered={[]}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(plain.container.querySelector('[data-fsrow="x"]')!);
    expect(plain.container.querySelector("[data-projectname]")).toBeNull();
  });

  test("a folder chip on a folder chat offers Add as project", async () => {
    const onAddAsProject = vi.fn();
    const lead = {
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
    const emp: EmpFn = (id) => (id === "builder" ? lead : undefined);
    const human: HumanFn = () => undefined;
    const root: Extract<Msg, { kind: "msg" }> = {
      kind: "msg",
      id: "m1",
      from: "ada",
      time: "10:00",
      text: "hi",
    };
    const dmChannel: Channel = {
      id: "dm-builder",
      name: "Builder",
      employees: ["builder"],
      dm: true,
    };
    const t: Thread = {
      session: "s_x",
      replies: [],
      ws: {
        folder: "f1",
        project: "",
        repo: "",
        mode: "direct",
        base: "main",
        branch: "main",
        cwd: "~/code/journal-app",
      },
    };
    const r = render(
      <ThreadView
        root={root}
        thread={t}
        channel={dmChannel}
        emp={emp}
        human={human}
        running={false}
        work={null}
        resolved={{}}
        onSend={() => {}}
        onAddAsProject={onAddAsProject}
      />,
    );
    await act(async () => {
      fireEvent.click(r.container.querySelector("[data-wsbadge]")!);
    });
    const item = document.body.querySelector(
      "[data-add-as-project]",
    ) as HTMLElement;
    expect(item.textContent).toContain("Add as project");
    await act(async () => {
      fireEvent.click(item);
    });
    expect(onAddAsProject).toHaveBeenCalledTimes(1);
    cleanup();
    // Without the action the menu carries no such row.
    render(
      <ThreadView
        root={root}
        thread={t}
        channel={dmChannel}
        emp={emp}
        human={human}
        running={false}
        work={null}
        resolved={{}}
        onSend={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(document.querySelector("[data-wsbadge]")!);
    });
    expect(document.body.querySelector("[data-add-as-project]")).toBeNull();
  });
});
