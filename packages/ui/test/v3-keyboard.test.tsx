// @vitest-environment happy-dom
/* Keyboard behaviour of v3's inline editors and menus: Esc closes the surface
   you are in and nothing behind it (a view or peek that also listens for Esc
   must not take the key first), a cancelled rename never saves, and the
   keyboard lands back on the control that opened an editor or a confirm. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useUiLayer } from "../src/chat/ui-layers";
import { V3AgentPage } from "../src/v3/v3-agent";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3DraftChat } from "../src/v3/v3-draft-chat";
import type { V3Actions } from "../src/v3/v3-page-types";
import { ThreadMenu, useRenameMenu } from "../src/v3/v3-thread-menu";
import type { V3Agent } from "../src/v3/v3-types";

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
    updateAgent: vi.fn(async () => undefined),
    removeAgent: vi.fn(async () => {}),
    ask: vi.fn(),
    scheduleSave: vi.fn(),
    ...over,
  }) as unknown as V3Actions;

/** What the shell does with Esc: it leaves a key a panel already used. */
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

describe("a new chat in a project", () => {
  test("`@` and `/` search the project's own folder", async () => {
    const searchFiles = vi.fn(async () => []);
    const searchCommands = vi.fn(async () => []);
    render(
      <V3DraftChat
        data={data({
          projects: [
            {
              id: "p1",
              name: "App",
              key: "APP",
              tone: "b",
              folder: "/repo/app",
              about: "",
            },
          ],
        })}
        go={vi.fn()}
        act={actions({ searchFiles, searchCommands })}
        id="emp_1"
      />,
    );
    const box = screen.getByLabelText(/^Message Reviewer/);
    await act(async () => {
      fireEvent.change(box, { target: { value: "@" } });
    });
    expect(searchFiles).toHaveBeenCalledWith("/repo/app", "");
    await act(async () => {
      fireEvent.change(box, { target: { value: "/" } });
    });
    expect(searchCommands).toHaveBeenCalledWith(
      { agentId: "emp_1", folder: "/repo/app" },
      "",
    );
  });
});

/** A view behind the title that also closes on Esc (a widened thread). */
function RenameHarness({
  onBack,
  onRename,
}: {
  onBack: () => void;
  onRename: (title: string) => void;
}) {
  useUiLayer({ onEscape: onBack });
  const { input, menu } = useRenameMenu({ title: "Old title", onRename });
  return (
    <div>
      {input ?? <span>Old title</span>}
      {menu}
    </div>
  );
}

function startRename() {
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
  return screen.getByRole("textbox", { name: "Thread title" });
}

describe("renaming a thread in place", () => {
  test("Esc cancels the rename: the view behind keeps its key, nothing is saved", () => {
    const onBack = vi.fn();
    const onRename = vi.fn();
    render(<RenameHarness onBack={onBack} onRename={onRename} />);
    const box = startRename();
    fireEvent.change(box, { target: { value: "Something else" } });
    press(box, "Escape");
    expect(screen.queryByRole("textbox", { name: "Thread title" })).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    // The keyboard is back on the ⋯ button, with its menu closed.
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Esc with nothing open is the view's again.
    press(trigger, "Escape");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("Enter saves the new title and returns to the ⋯ button", () => {
    const onRename = vi.fn();
    render(<RenameHarness onBack={vi.fn()} onRename={onRename} />);
    const box = startRename();
    fireEvent.change(box, { target: { value: "  New title " } });
    press(box, "Enter");
    expect(onRename).toHaveBeenCalledWith("New title");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Thread actions" }),
    );
  });
});

describe("an agent's connectors menu", () => {
  const connectors = [
    {
      id: "gh",
      label: "GitHub",
      kind: "cli",
      state: "ready",
      look: { mark: "G", color: "#000" },
      agents: [],
    },
  ];
  const mount = () =>
    render(
      <V3AgentPage
        data={data({
          connectors: connectors as unknown as V3Data["connectors"],
        })}
        go={vi.fn()}
        act={actions({ toggleConnector: vi.fn() })}
        id="emp_1"
      />,
    );

  test("is a menu: it opens on its first item, and Esc closes only it", () => {
    const shell = shellEsc();
    mount();
    const trigger = screen.getByRole("button", { name: "+ Add" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Add a connector" });
    const first = screen.getByRole("menuitem", { name: /GitHub/ });
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);

    press(first, "ArrowDown");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Manage connectors…" }),
    );
    press(document.activeElement as Element, "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(shell.closePeek).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    shell.off();
  });
});

describe("a schedule being written", () => {
  test("Esc closes the editor and not the peek behind it", () => {
    const shell = shellEsc();
    mountAgent();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    expect(
      screen.getByRole("button", { name: "Create schedule" }),
    ).toBeTruthy();
    // On a button, not in a field: the case a bare onKeyDown let through.
    const kind = screen.getByRole("button", { name: "Weekdays" });
    kind.focus();
    press(kind, "Escape");
    expect(
      screen.queryByRole("button", { name: "Create schedule" }),
    ).toBeNull();
    expect(shell.closePeek).not.toHaveBeenCalled();
    shell.off();
  });
});

/* A row's ⋯ menu inside the Threads list: the list is a container-query box,
   which confined the old full-screen click catcher to itself, so a second
   row's menu opened on top of the first and neither would close. */
describe("thread row menus", () => {
  const rows = () =>
    render(
      <div style={{ containerType: "inline-size" }}>
        <ThreadMenu onRename={vi.fn()} onArchive={vi.fn()} />
        <ThreadMenu onRename={vi.fn()} onArchive={vi.fn()} />
        <p>elsewhere</p>
      </div>,
    );
  const menus = () => screen.queryAllByRole("menu");

  test("opening another row's menu closes the first: one menu at a time", () => {
    rows();
    const [first, second] = screen.getAllByRole("button", {
      name: "Thread actions",
    });
    fireEvent.click(first);
    expect(menus()).toHaveLength(1);
    fireEvent.pointerDown(second);
    fireEvent.click(second);
    expect(menus()).toHaveLength(1);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
  });

  test("a press anywhere outside closes it; its own trigger toggles it", () => {
    rows();
    const [first] = screen.getAllByRole("button", { name: "Thread actions" });
    fireEvent.click(first);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(menus()).toHaveLength(0);
    fireEvent.click(first);
    expect(menus()).toHaveLength(1);
    fireEvent.pointerDown(first);
    fireEvent.click(first);
    expect(menus()).toHaveLength(0);
  });
});

describe("focus returns to the control that opened an editor or confirm", () => {
  test("agent Edit: Save and Cancel go back to Edit", async () => {
    mountAgent();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Maker" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    press(screen.getByLabelText("Role"), "Escape");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit" }),
    );
  });

  test("Remove from company: the question opens on Cancel and closes back on the trigger", () => {
    mountAgent();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from company" }),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove from company" }),
    );
  });
});

function mountAgent() {
  return render(
    <V3AgentPage data={data()} go={vi.fn()} act={actions()} id="emp_1" />,
  );
}
