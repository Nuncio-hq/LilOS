// @vitest-environment happy-dom
/* AC tests for issues #577, #581, #590 (Group D — navigation + folders):
   #577 the panel has a visible ✕ back to the DM list and Focus has ONE back
   control named for where it goes (the header panel-toggle icon belonged to
   the old DM home, which is gone); #581 a folder-less DM thread offers
   "Add a folder" and the dialog
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
import {
  AddFolderDialog,
  NEW_PROJECT_COPY,
  NEW_PROJECT_PAUSED_COPY,
} from "../src/dialogs/add-folder-dialog";
import { FocusView } from "../src/focus/focus-view";
import { SessionUsage } from "../src/focus/session-usage";
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

  test("AC-3 Focus draws no back control of its own; Esc is the way out beside the peek's Narrow", () => {
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
    // The widened peek's Narrow (the shell's header) is the one control; the
    // thread has neither "Back to …" nor "Exit focus" (#577).
    expect(dm.queryByRole("button", { name: /^Back to/ })).toBeNull();
    expect(dm.container.querySelectorAll('[title="Exit focus"]').length).toBe(
      0,
    );
    expect(dm.container.textContent).not.toContain("Exit focus");
    // Esc still backs out (the layer the shell's Narrow mirrors).
    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
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

  test("#854 paused (D-#836): no Key field or ticket words — the name still drives the key", () => {
    const fs = {
      "~": { children: ["code"] },
      "~/code": {
        children: [],
        git: { branches: ["main"], remote: "o/app" },
      },
    };
    const onAdd = vi.fn();
    const r = render(
      <AddFolderDialog
        folders={[]}
        projectFields
        company={false}
        copy={NEW_PROJECT_PAUSED_COPY}
        fs={fs}
        discovered={[]}
        onClose={() => {}}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(r.container.querySelector('[data-fsrow="code"]')!);
    // The name prefills from the folder; no key field, no "key prefixes the
    // tickets" line, and the footer path truncates from the left (rtl).
    expect(
      (r.container.querySelector("[data-projectname]") as HTMLInputElement)
        .value,
    ).toBe("code");
    expect(r.container.querySelector("[data-projectkey]")).toBeNull();
    expect(r.container.textContent).not.toContain("prefixes");
    expect(r.container.textContent).toContain("Pick a folder for this project");
    expect(r.container.querySelector("span[dir='rtl']")).not.toBeNull();
    // onAdd still carries the key — derived from the name, never asked for.
    fireEvent.click(r.container.querySelector("[data-addbtn]")!);
    expect(onAdd).toHaveBeenCalledWith("~/code", {
      name: "code",
      key: "COD",
    });
    r.unmount();
    /* The company layer shows the key back: the field and its words are
       the default, for the app where tickets exist. */
    const on = render(
      <AddFolderDialog
        folders={[]}
        projectFields
        copy={NEW_PROJECT_COPY}
        fs={fs}
        discovered={[]}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(on.container.querySelector('[data-fsrow="code"]')!);
    expect(
      (on.container.querySelector("[data-projectkey]") as HTMLInputElement)
        .value,
    ).toBe("COD");
    expect(on.container.textContent).toContain("prefixes");
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

  test("AC-1 the composer lands the same caret while a turn runs (the Focus view's steer box)", async () => {
    const r = render(
      <Composer
        status="streaming"
        placeholder="Reply…"
        employees={[]}
        hint=""
        draft=""
        onDraftChange={() => {}}
        onSend={() => {}}
      />,
    );
    const ta = r.container.querySelector("textarea")!;
    await act(async () => {
      r.rerender(
        <Composer
          status="streaming"
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

  test("AC-2 the Focus header does not repeat who the thread is with (the peek's trail names it)", () => {
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
    // No "Chat · Builder" kicker — and never DM channel wording.
    expect(header.textContent).not.toContain("Chat · Builder");
    expect(header.textContent).not.toContain("DM");
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
