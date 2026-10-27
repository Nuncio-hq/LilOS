// @vitest-environment happy-dom
/* One composer for both views: the narrow thread panel and the widened Focus
   session render the same `Composer`, so the `@` mention menu, the `/` slash
   menu, the attachment cap and the model picker reach both — in the idle
   (`ready`) and the running/steer (`streaming`) state alike. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ChatStatus } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import type { Employee, ModelOption, SlashItem } from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
}
afterEach(cleanup);

const BUILDER: Employee = {
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

const MODELS: ModelOption[] = [
  { id: "qwen", name: "Qwen", provider: "hpc" },
  { id: "gpt-test-5", name: "GPT test 5", provider: "openai" },
];

const COMMANDS: SlashItem[] = [
  { name: "help", description: "What the engine can do", kind: "command" },
  { name: "review", description: "Review the diff", kind: "skill" },
];
const searchCommands = (q: string) =>
  Promise.resolve(COMMANDS.filter((c) => c.name.includes(q)));

const box = (c: HTMLElement) =>
  c.querySelector("textarea") as HTMLTextAreaElement;
const picker = (c: HTMLElement) =>
  c.querySelector('[data-slot="model-picker-trigger"]');
const attach = (c: HTMLElement, names: string[]) => {
  const input = c.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: names.map((n) => new File(["png"], n, { type: "image/png" })),
    },
  });
};

describe.each<ChatStatus>(["ready", "streaming"])(
  "the one Composer while %s",
  (status) => {
    test("`@` opens the mention menu with the employees", async () => {
      const c = render(
        <Composer
          placeholder="Reply…"
          employees={[BUILDER]}
          hint=""
          status={status}
        />,
      );
      fireEvent.change(box(c.container), { target: { value: "@" } });
      const lb = await c.findByRole("listbox");
      expect(
        lb.querySelector('[data-mention-section="employees"]'),
      ).toBeTruthy();
      expect(c.getByText("Builder")).toBeTruthy();
    });

    test("`/` opens the commands menu from onSearchCommands; without it `/` stays plain text (D-#19)", async () => {
      const onSearchCommands = vi.fn(searchCommands);
      const c = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          onSearchCommands={onSearchCommands}
        />,
      );
      fireEvent.change(box(c.container), { target: { value: "/rev" } });
      await c.findByRole("listbox", { name: "Commands" });
      await waitFor(() =>
        expect(
          c.container.querySelector('[data-slash-command="review"]'),
        ).toBeTruthy(),
      );
      expect(
        c.container.querySelector('[data-slash-command="help"]'),
      ).toBeNull();
      expect(onSearchCommands).toHaveBeenCalledWith("rev");

      const off = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
        />,
      );
      fireEvent.change(box(off.container), { target: { value: "/rev" } });
      expect(off.container.querySelector('[role="listbox"]')).toBeNull();
    });

    test("maxFiles caps what a send carries and tells the host about the files left out", async () => {
      const onAttachError = vi.fn();
      const capped = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          accept="image/*"
          maxFiles={1}
          onAttachError={onAttachError}
        />,
      );
      await act(async () => attach(capped.container, ["a.png", "b.png"]));
      expect(onAttachError).toHaveBeenCalledTimes(1);
      expect(onAttachError).toHaveBeenCalledWith(
        expect.stringMatching(/too many files/i),
      );

      /* Without a cap the same pair is welcome — the refusal above is the cap's. */
      const free = vi.fn();
      const open = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          accept="image/*"
          onAttachError={free}
        />,
      );
      await act(async () => attach(open.container, ["a.png", "b.png"]));
      expect(free).not.toHaveBeenCalled();
    });

    test("the model picker needs both its handler and a model list", () => {
      const on = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          models={MODELS}
          onModel={() => {}}
        />,
      );
      expect(picker(on.container)).toBeTruthy();
      const noHandler = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          models={MODELS}
        />,
      );
      expect(picker(noHandler.container)).toBeNull();
      const noModels = render(
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          status={status}
          models={[]}
          onModel={() => {}}
        />,
      );
      expect(picker(noModels.container)).toBeNull();
    });
  },
);

/* #895: a thread on a runtime whose own catalog hasn't landed keeps its
   model on screen, read-only — and the picker takes over once it lands. */
describe("the thread composer's model slot (#895)", () => {
  const props = {
    placeholder: "Message Devin…",
    employees: [BUILDER],
    onModel: () => {},
  };

  test("no models + a pick: a read-only chip, no picker", () => {
    const { container } = render(
      <Composer {...props} modelStatic="Swe-2-high" />,
    );
    const chip = container.querySelector('[data-slot="model-chip-static"]');
    expect(chip?.textContent).toBe("Swe-2-high");
    expect(picker(container)).toBeNull();
  });

  test("models landed: the picker replaces the chip", () => {
    const { container } = render(
      <Composer
        {...props}
        modelStatic="Swe-2-high"
        models={[{ id: "swe-2-high", name: "SWE-2 High", provider: "devin" }]}
      />,
    );
    expect(
      container.querySelector('[data-slot="model-chip-static"]'),
    ).toBeNull();
    expect(picker(container)?.textContent).toContain("SWE-2 High");
  });

  test("nothing to show: neither", () => {
    const { container } = render(<Composer {...props} />);
    expect(
      container.querySelector('[data-slot="model-chip-static"]'),
    ).toBeNull();
    expect(picker(container)).toBeNull();
  });
});
