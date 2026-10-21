// @vitest-environment happy-dom
/* The thread panel (ThreadView) and the widened session (FocusView) are two
   frames over ONE set of shared pieces — header, turn list, composer — and one
   props interface (ThreadFrameProps). Whatever the host passes, both honour:
   the widened session once lost the `@` and `/` menus and the attachment cap
   by being a second, drifted list. Each case runs on both frames. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import { ThreadView } from "../src/thread/thread-view";
import type {
  Channel,
  EmpFn,
  Employee,
  HumanFn,
  ModelOption,
  Msg,
  PullRequest,
  SlashItem,
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
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);

const BUILDER: Employee = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online",
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone",
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" || id === "user"
    ? { name: "Ada", color: "bg-blue-600" }
    : undefined;
const channel: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "add a notes line",
};
const reply = {
  id: "r1",
  from: "builder",
  time: "10:04",
  text: "Done.",
  phase: "done" as const,
};
const thread: Thread = { session: "s_abc123", replies: [reply] };
const MODELS: ModelOption[] = [
  { id: "qwen", name: "Qwen", provider: "hpc" },
  { id: "gpt-test-5", name: "GPT test 5", provider: "openai" },
];
const COMMANDS: SlashItem[] = [
  { name: "review", description: "Review the diff", kind: "skill" },
];

/* The props both frames take identically. */
const shared = {
  root,
  thread,
  channel,
  lead: BUILDER,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  onSend: () => {},
} as const;

const FRAMES = {
  "thread panel": (p: object) => <ThreadView {...shared} {...p} />,
  "widened session": (p: object) => <FocusView {...shared} {...p} />,
};

describe.each(Object.entries(FRAMES))("%s", (_name, frame) => {
  const box = (c: HTMLElement) =>
    c.querySelector("textarea") as HTMLTextAreaElement;

  test("`@` opens the mention menu with the host's employees", async () => {
    const r = render(frame({ mentionables: [BUILDER] }));
    fireEvent.change(box(r.container), { target: { value: "@" } });
    const lb = await r.findByRole("listbox");
    expect(lb.querySelector('[data-mention-section="employees"]')).toBeTruthy();
  });

  test("`/` opens the commands menu from onSearchCommands", async () => {
    const onSearchCommands = vi.fn((q: string) =>
      Promise.resolve(COMMANDS.filter((c) => c.name.includes(q))),
    );
    const r = render(frame({ onSearchCommands }));
    fireEvent.change(box(r.container), { target: { value: "/rev" } });
    await r.findByRole("listbox", { name: "Commands" });
    await waitFor(() =>
      expect(
        r.container.querySelector('[data-slash-command="review"]'),
      ).toBeTruthy(),
    );
    expect(onSearchCommands).toHaveBeenCalledWith("rev");
  });

  test("maxFiles caps an attachment send and tells the host", async () => {
    const onAttachError = vi.fn();
    const r = render(frame({ accept: "image/*", maxFiles: 1, onAttachError }));
    const input = r.container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: ["a.png", "b.png"].map(
            (n) => new File(["png"], n, { type: "image/png" }),
          ),
        },
      });
    });
    expect(onAttachError).toHaveBeenCalledWith(
      expect.stringMatching(/too many files/i),
    );
  });

  test("the model picker needs both the catalog and a handler (D-#19)", () => {
    const trigger = (c: HTMLElement) =>
      c.querySelector('[data-slot="model-picker-trigger"]');
    expect(trigger(render(frame({ models: MODELS })).container)).toBeNull();
    cleanup();
    expect(
      trigger(render(frame({ models: MODELS, onModel: () => {} })).container),
    ).toBeTruthy();
  });

  test("a thread an agent opened has no first message — no bare byline under the header", () => {
    const r = render(
      frame({ root: { ...root, text: "", attachments: undefined } }),
    );
    expect(r.container.querySelector("[data-thread-header]")).toBeTruthy();
    expect(r.container.querySelector(`[data-msg="m1"]`)).toBeNull();
    expect(r.container.querySelector("[data-userturn]")).toBeNull();
  });

  test("the PR card rides the turn that ran gh pr create", () => {
    const pr: PullRequest = {
      number: 7,
      repo: "acme/widgets",
      title: "Add the notes line",
      body: "",
      status: "open",
      author: "builder",
      base: "trunk",
      head: "feat/notes",
      opened: "1h",
      checks: [],
      comments: [],
    };
    const made: Thread = {
      session: "s_abc123",
      pr,
      replies: [
        {
          ...reply,
          steps: [
            {
              id: "st1",
              tool: "terminal",
              title: "gh pr create --fill",
              input: { command: "gh pr create --fill" },
              output: "",
            },
          ],
        },
      ],
    };
    const r = render(frame({ thread: made }));
    expect(r.container.querySelector("[data-prcard]")).toBeTruthy();
    expect(r.container.textContent).toContain("Add the notes line");
  });
});
