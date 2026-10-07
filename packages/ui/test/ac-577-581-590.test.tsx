// @vitest-environment happy-dom
/* AC tests for issues #577, #581, #590 (Group D — navigation + folders):
   #577 the panel has a visible ✕ back to the DM list, the header panel icon
   is a labelled toggle, and Focus has ONE back control named for where it
   goes; #581 a folder-less DM thread offers "Add a folder" and the dialog
   opens clean (nothing picked, no dev text, no unbuilt promises); #590 a
   prefilled draft lands the caret after the prefix, Focus's header names the
   employee, the context meter has a tooltip, and Status shows no internals. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import { FocusComposer } from "../src/chat/focus-composer";
import { AddFolderDialog } from "../src/dialogs/add-folder-dialog";
import { EmployeeHome } from "../src/employee/employee-home";
import { FocusView } from "../src/focus/focus-view";
import { SessionUsage } from "../src/focus/session-usage";
import { NO_WS } from "../src/lib/helpers";
import { StatusDialog } from "../src/shell/status";
import { ThreadView } from "../src/thread/thread-view";
import type {
  Channel,
  EmpFn,
  HumanFn,
  Msg,
  StatusComponent,
  Thread,
} from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
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
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(cb, 0) as unknown as number;
}
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);

const BUILDER = {
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
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" || id === "user"
    ? { name: "Ada", color: "bg-blue-600" }
    : undefined;

const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "@builder add a notes line",
};
const reply = {
  id: "r1",
  from: "builder",
  time: "10:04",
  text: "Done.",
  phase: "done" as const,
};
const thread: Thread = { session: "s_abc123", replies: [reply] };
const dmChannel: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
const channel: Channel = {
  id: "eng",
  name: "engineering",
  employees: ["builder"],
};

const panelProps = {
  root,
  thread,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  onSend: () => {},
} as const;

describe("issue #577 — way back", () => {
  test("AC-2 the thread panel has a visible ✕ that calls onClose", () => {
    const onClose = vi.fn();
    const r = render(
      <ThreadView {...panelProps} channel={dmChannel} onClose={onClose} />,
    );
    const x = r.getByRole("button", { name: "Close thread panel" });
    fireEvent.click(x);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("AC-2 the DM header panel icon is a labelled toggle", () => {
    const onPanel = vi.fn();
    const onPanelClose = vi.fn();
    const home = (panelOpen: boolean) => (
      <EmployeeHome
        e={BUILDER}
        feed={[]}
        threadId={null}
        emp={emp}
        human={human}
        onNav={() => {}}
        onProfile={() => {}}
        onOpen={() => {}}
        onSend={() => {}}
        panelOpen={panelOpen}
        onPanel={onPanel}
        onPanelClose={onPanelClose}
        folders={[]}
        pick={NO_WS}
        setPick={() => {}}
      />
    );
    const r = render(home(false));
    const toggle = r.container.querySelector("[data-panel-toggle]")!;
    expect(toggle.textContent).toContain("Panel");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show the latest thread");
    fireEvent.click(toggle);
    expect(onPanel).toHaveBeenCalledTimes(1);
    cleanup();
    const open = render(home(true));
    const openToggle = open.container.querySelector("[data-panel-toggle]")!;
    expect(openToggle.getAttribute("aria-pressed")).toBe("true");
    expect(openToggle.getAttribute("aria-label")).toBe("Hide the thread panel");
    fireEvent.click(openToggle);
    expect(onPanelClose).toHaveBeenCalledTimes(1);
    expect(onPanel).toHaveBeenCalledTimes(1);
  });

  test("AC-3 Focus has ONE back control, labelled for where it goes", () => {
    const onBack = vi.fn();
    const dm = render(
      <FocusView
        root={root}
        thread={thread}
        channel={dmChannel}
        lead={BUILDER}
        emp={emp}
        human={human}
        running={false}
        work={null}
        resolved={{}}
        onSend={() => {}}
        onBack={onBack}
      />,
    );
    const back = dm.getByRole("button", { name: "Back to DM" });
    // One control only — no second "Exit focus" affordance (#577).
    expect(dm.container.querySelectorAll('[title="Exit focus"]').length).toBe(
      0,
    );
    expect(dm.container.textContent).not.toContain("Exit focus");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    cleanup();
    const ch = render(
      <FocusView
        root={root}
        thread={thread}
        channel={channel}
        lead={BUILDER}
        emp={emp}
        human={human}
        running={false}
        work={null}
        resolved={{}}
        onSend={() => {}}
        onBack={onBack}
      />,
    );
    expect(
      ch.getByRole("button", { name: "Back to #engineering" }),
    ).toBeTruthy();
  });
});

describe("issue #581 — folders", () => {
  test("AC-2 a folder-less DM thread shows Add a folder; one with a folder doesn't", () => {
    const onAddFolder = vi.fn();
    const bare = render(
      <ThreadView
        {...panelProps}
        channel={dmChannel}
        onAddFolder={onAddFolder}
      />,
    );
    const btn = bare.container.querySelector("[data-add-folder]")!;
    expect(btn.textContent).toContain("Add a folder");
    fireEvent.click(btn);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    cleanup();
    // A session that HAS a folder shows the workspace badge, not the affordance.
    const homed = render(
      <ThreadView
        {...panelProps}
        channel={dmChannel}
        thread={{
          ...thread,
          ws: {
            folder: "f1",
            project: "",
            repo: "",
            mode: "direct",
            base: "main",
            branch: "main",
            cwd: "~/code/app",
          },
        }}
        onAddFolder={onAddFolder}
      />,
    );
    expect(homed.container.querySelector("[data-add-folder]")).toBeNull();
  });

  test("AC-3 the dialog opens with nothing picked, no dev text, no workstream promise", () => {
    const r = render(
      <AddFolderDialog
        folders={[]}
        fs={{
          "~": { children: ["code"] },
          "~/code": {
            children: [],
            git: { branches: ["main"], remote: "o/app" },
          },
        }}
        discovered={[]}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    // Nothing selected → the home listing and a disabled Add.
    expect(r.container.textContent).not.toContain("~/Desktop");
    expect(
      (r.container.querySelector("[data-addbtn]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // No dev surface: no wire call, no "Hermes call", no unbuilt workstreams.
    expect(r.container.textContent).not.toContain("folders.add");
    expect(r.container.textContent).not.toContain("Hermes call");
    expect(r.container.textContent.toLowerCase()).not.toContain("workstream");
    expect(r.container.textContent.toLowerCase()).not.toContain("worktree");
    // Picking a real dir names it plainly and enables Add.
    fireEvent.click(r.container.querySelector('[data-fsrow="code"]')!);
    expect(r.container.textContent).toContain(
      "Sessions edit files here directly.",
    );
    expect(
      (r.container.querySelector("[data-addbtn]") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("issue #590 — desktop polish", () => {
  test("AC-1 an external prefill focuses the composer with the caret after the prefix", async () => {
    const r = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        draft=""
        onDraftChange={() => {}}
        onSend={() => {}}
      />,
    );
    const ta = r.container.querySelector("textarea")!;
    expect(document.activeElement).not.toBe(ta);
    await act(async () => {
      r.rerender(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          draft="Change the plan: "
          onDraftChange={() => {}}
          onSend={() => {}}
        />,
      );
    });
    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe("Change the plan: ".length);
  });

  test("AC-1 the Focus composer lands the same caret", async () => {
    const r = render(
      <FocusComposer
        running={false}
        status="ready"
        placeholder="Reply…"
        hint=""
        draft=""
        onDraftChange={() => {}}
        onSend={() => {}}
      />,
    );
    const ta = r.container.querySelector("textarea")!;
    await act(async () => {
      r.rerender(
        <FocusComposer
          running={false}
          status="ready"
          placeholder="Reply…"
          hint=""
          draft="Change the plan: "
          onDraftChange={() => {}}
          onSend={() => {}}
        />,
      );
    });
    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe("Change the plan: ".length);
  });

  test("AC-2 the Focus header names the employee", () => {
    const r = render(
      <FocusView
        root={root}
        thread={thread}
        channel={dmChannel}
        lead={BUILDER}
        emp={emp}
        human={human}
        running={false}
        work={null}
        resolved={{}}
        onSend={() => {}}
      />,
    );
    const header = r.container.querySelector("header")!;
    expect(header.textContent).toContain("Builder");
    expect(header.textContent).toContain("DM");
  });

  test("AC-3 the context meter's tooltip names what the % is", () => {
    const r = render(
      <SessionUsage
        usage={{ input: 9000, output: 100, reasoning: 0, cache: 0 }}
        model="gpt-test-1"
      />,
    );
    const trigger = r.container.querySelector("button")!;
    expect(trigger.getAttribute("title")).toMatch(
      /^Context used: \d+(\.\d+)?% of ~?\d/,
    );
  });

  test("AC-3 Status never shows a CLI command", () => {
    const components: StatusComponent[] = [
      { id: "relay", label: "Relay", state: "ok", reason: "ok" },
      { id: "harness", label: "Harness", state: "ok", reason: "ok" },
      { id: "engine", label: "Engine", state: "ok", reason: "ok" },
      { id: "model", label: "Model", state: "ok", reason: "ok" },
    ];
    const r = render(
      <StatusDialog
        components={components}
        diagnostics="diag"
        onClose={() => {}}
        onCopied={() => {}}
      />,
    );
    const dialog = within(r.container).getByRole("dialog", {
      name: "System status",
    });
    expect(dialog.textContent).not.toContain("--verbose");
    expect(dialog.textContent).not.toContain("lilos status");
  });
});
