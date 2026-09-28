// @vitest-environment happy-dom
/* AC tests for issue #105: the `@` mention menu in the composer gains a Files
   section — files/folders of the session's folder come back from the host's
   onSearchFiles handler, fuzzy-matched by it; picking one inserts an `@path`
   token that Backspace removes whole, and the wire text stays plain (`@path`,
   never file contents). */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import type { Employee, FileMention } from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

const FILES: FileMention[] = [
  { path: "src", kind: "dir" },
  { path: "src/app.tsx", kind: "file" },
  { path: "src/util/deep.ts", kind: "file" },
  { path: "docs", kind: "dir" },
  { path: "docs/guide.md", kind: "file" },
  { path: "secret.env", kind: "file" }, // host-side gitignore already filtered; mock keeps it simple
];

const search = (q: string): Promise<FileMention[]> =>
  Promise.resolve(
    FILES.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())),
  );

const box = (c: HTMLElement) =>
  c.querySelector("textarea") as HTMLTextAreaElement;
const menu = (c: HTMLElement) => c.querySelector('[role="listbox"]');

describe("issue #105 file mentions in the composer", () => {
  test("AC-1 `@` opens one menu with an Employees section and a Files section", async () => {
    const onSearchFiles = vi.fn(search);
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[BUILDER]}
        hint=""
        onSearchFiles={onSearchFiles}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "@" } });
    const lb = await c.findByRole("listbox");
    expect(lb.querySelector('[data-mention-section="employees"]')).toBeTruthy();
    expect(await c.findByText("src/app.tsx")).toBeTruthy();
    expect(lb.querySelector('[data-mention-section="files"]')).toBeTruthy();
    expect(onSearchFiles).toHaveBeenCalledWith("");
    // the query narrows the file rows, employees stay unfiltered (as before)
    fireEvent.change(el, { target: { value: "@app" } });
    expect(await c.findByText("src/app.tsx")).toBeTruthy();
    expect(c.queryByText("docs/guide.md")).toBeNull();
    expect(c.getByText("Builder")).toBeTruthy();
  });

  test("AC-1 Arrow keys + Enter pick an item; Esc closes the menu", async () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[BUILDER]}
        hint=""
        onSearchFiles={search}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "@app" } });
    const row = await c.findByText("src/app.tsx");
    // flat navigation across both sections: ↓ moves off the first employee
    // row onto the file row; Enter inserts the token, not a newline.
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(row.closest('[role="option"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(el, { key: "Enter" });
    expect(el.value).toBe("@src/app.tsx ");
    expect(menu(c.container)).toBeNull();
    // reopen, then Esc dismisses (same as today's menu)
    fireEvent.change(el, { target: { value: "@src/app.tsx @ap" } });
    await c.findByRole("listbox");
    fireEvent.keyDown(el, { key: "Escape" });
    expect(menu(c.container)).toBeNull();
  });

  test("AC-2 with no onSearchFiles handler the Files section does not render (D-#19)", async () => {
    const c = render(
      <Composer placeholder="Reply…" employees={[BUILDER]} hint="" />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "@" } });
    const lb = await c.findByRole("listbox");
    expect(lb.querySelector('[data-mention-section="employees"]')).toBeTruthy();
    expect(lb.querySelector('[data-mention-section="files"]')).toBeNull();
  });

  test("AC-3 picking a file inserts the @path token; Backspace removes the whole chip", async () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[BUILDER]}
        hint=""
        onSearchFiles={search}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "check @app" } });
    const row = await c.findByText("src/app.tsx");
    fireEvent.click(row);
    expect(el.value).toBe("check @src/app.tsx ");
    // one Backspace at the caret after the token deletes the whole chip
    el.setSelectionRange(el.value.length, el.value.length);
    fireEvent.keyDown(el, { key: "Backspace" });
    expect(el.value).toBe("check ");
  });

  test("AC-3 a folder mention inserts `@dir/` and Backspace removes it whole", async () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        onSearchFiles={search}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "@sr" } });
    const row = await c.findByText("src/");
    fireEvent.click(row);
    expect(el.value).toBe("@src/ ");
    el.setSelectionRange(el.value.length, el.value.length);
    fireEvent.keyDown(el, { key: "Backspace" });
    expect(el.value).toBe("");
  });

  test("AC-4 the composer sends the @path as plain text — no blocks, no contents", async () => {
    const sent: string[] = [];
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        onSearchFiles={search}
        onSend={(t) => {
          sent.push(t);
        }}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "read @guide" } });
    const row = await c.findByText("docs/guide.md");
    fireEvent.click(row);
    expect(el.value).toBe("read @docs/guide.md ");
    fireEvent.submit(c.container.querySelector("form")!);
    expect(sent).toEqual(["read @docs/guide.md"]);
  });
});
