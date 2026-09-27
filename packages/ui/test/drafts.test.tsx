// @vitest-environment happy-dom
/* Issue #103 — per-conversation composer drafts. Store semantics (set / get /
   clear / prune / blocked storage), the useDraft key-swap, and the Composer's
   controlled contract incl. AC-5's failed-send-keeps-text. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import {
  clearDraft,
  draftKey,
  dropDrafts,
  getDraft,
  setDraft,
  useDraft,
} from "../src/lib/drafts";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("draft store", () => {
  test("AC-1 drafts are stored per key — one conversation never sees another's text", () => {
    setDraft(draftKey.thread("conv-a"), "draft for A");
    setDraft(draftKey.thread("conv-b"), "draft for B");
    expect(getDraft(draftKey.thread("conv-a"))).toBe("draft for A");
    expect(getDraft(draftKey.thread("conv-b"))).toBe("draft for B");
  });

  test("AC-2 the DM-channel draft is its own key, separate from every thread", () => {
    setDraft(draftKey.dm("ch-1"), "home draft");
    setDraft(draftKey.thread("conv-a"), "thread draft");
    expect(getDraft(draftKey.dm("ch-1"))).toBe("home draft");
    expect(getDraft(draftKey.thread("conv-a"))).toBe("thread draft");
  });

  test("AC-5 clearDraft removes only that draft", () => {
    setDraft(draftKey.thread("conv-a"), "a");
    setDraft(draftKey.thread("conv-b"), "b");
    clearDraft(draftKey.thread("conv-a"));
    expect(getDraft(draftKey.thread("conv-a"))).toBe("");
    expect(getDraft(draftKey.thread("conv-b"))).toBe("b");
  });

  test("AC-6 writing empty text removes the entry; dropDrafts prunes a set", () => {
    setDraft(draftKey.thread("conv-a"), "a");
    setDraft(draftKey.thread("conv-b"), "");
    const keys = () =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith("lilos:composer-draft:"),
      );
    // The empty write stored nothing.
    expect(keys()).toHaveLength(1);
    dropDrafts([draftKey.thread("conv-a"), draftKey.dm("dm-emp-1")]);
    expect(keys()).toHaveLength(0);
  });

  test("blocked storage means no draft, never a crash", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError");
    });
    expect(() => setDraft(draftKey.thread("conv-a"), "x")).not.toThrow();
    spy.mockRestore();
    const getSpy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(getDraft(draftKey.thread("conv-a"))).toBe("");
    getSpy.mockRestore();
  });
});

function Harness({ k }: { k?: string }) {
  const [draft, setDraft] = useDraft(k);
  return (
    <textarea
      data-testid="draft-box"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

const type = (box: HTMLTextAreaElement, v: string) =>
  fireEvent.change(box, { target: { value: v } });

describe("useDraft", () => {
  test("AC-1/AC-3 switching keys swaps in that key's stored draft", () => {
    const { rerender, getByTestId } = render(
      <Harness k={draftKey.thread("conv-a")} />,
    );
    const box = getByTestId("draft-box") as HTMLTextAreaElement;
    act(() => type(box, "still typing in A"));
    expect(box.value).toBe("still typing in A");

    rerender(<Harness k={draftKey.thread("conv-b")} />);
    expect(box.value).toBe("");
    act(() => type(box, "B draft"));

    rerender(<Harness k={draftKey.thread("conv-a")} />);
    expect(box.value).toBe("still typing in A");
  });

  test("AC-6 clearing the text removes the stored draft", () => {
    const { getByTestId } = render(<Harness k={draftKey.thread("conv-a")} />);
    const box = getByTestId("draft-box") as HTMLTextAreaElement;
    act(() => type(box, "temp"));
    expect(getDraft(draftKey.thread("conv-a"))).toBe("temp");
    act(() => type(box, ""));
    expect(getDraft(draftKey.thread("conv-a"))).toBe("");
    expect(localStorage.length).toBe(0);
  });
});

const mustBox = (container: HTMLElement): HTMLTextAreaElement => {
  const box = container.querySelector("textarea");
  if (!box) throw new Error("no textarea rendered");
  return box;
};

const renderComposer = (props: {
  draft?: string;
  onDraftChange?: (v: string) => void;
  onSend?: ComponentProps<typeof Composer>["onSend"];
}) =>
  render(
    <Composer
      placeholder="Reply…"
      employees={[]}
      hint="hint"
      draft={props.draft}
      onDraftChange={props.onDraftChange}
      onSend={props.onSend}
    />,
  );

const submit = async (box: HTMLTextAreaElement) => {
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  // PromptInput's submit resolves through promise ticks — a macrotask lets
  // the whole chain (send → clearIfUnchanged) settle.
  await act(() => new Promise((r) => setTimeout(r, 0)));
};

describe("Composer controlled draft", () => {
  test("controlled: the host's value shows and edits flow through onDraftChange", () => {
    const onDraftChange = vi.fn();
    const { container } = renderComposer({
      draft: "kept by the host",
      onDraftChange,
    });
    const box = mustBox(container);
    expect(box.value).toBe("kept by the host");
    act(() => type(box, "host + edit"));
    expect(onDraftChange).toHaveBeenLastCalledWith("host + edit");
  });

  test("AC-5 a resolved send clears via onDraftChange('')", async () => {
    let draft = "send me";
    const onDraftChange = vi.fn((v: string) => {
      draft = v;
    });
    const onSend = () => Promise.resolve();
    const props = {
      placeholder: "Reply…",
      employees: [],
      hint: "hint",
      draft,
      onDraftChange,
      onSend,
    };
    const { container, rerender } = render(<Composer {...props} />);
    const box = mustBox(container);
    await submit(box);
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(draft).toBe("");
    rerender(<Composer {...props} draft={draft} />);
    expect(box.value).toBe("");
  });

  test("AC-5 a failed send keeps the text (no lost message)", async () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn(() => Promise.reject(new Error("relay down")));
    const { container } = renderComposer({
      draft: "do not lose me",
      onDraftChange,
      onSend,
    });
    const box = mustBox(container);
    await submit(box);
    expect(onSend).toHaveBeenCalledOnce();
    expect(onDraftChange).not.toHaveBeenCalledWith("");
    expect(box.value).toBe("do not lose me");
  });

  test("uncontrolled without draft props: today's behaviour is unchanged", async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint="hint"
        onSend={onSend}
      />,
    );
    const box = mustBox(container);
    act(() => type(box, "ephemeral"));
    expect(box.value).toBe("ephemeral");
    await submit(box);
    expect(onSend).toHaveBeenCalledWith("ephemeral", []);
    expect(box.value).toBe("");
  });
});
