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
  clearDraftIfSent,
  draftKey,
  draftSendKey,
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

  test("AC-5 clearDraftIfSent drops the sent draft by key — not the open one, not mid-send typing", () => {
    /* Send resolves after switching: A's draft (still the sent text) goes,
       B's untouched. */
    setDraft(draftKey.thread("conv-a"), "sent from A");
    setDraft(draftKey.thread("conv-b"), "draft for B");
    clearDraftIfSent(draftKey.thread("conv-a"), "sent from A");
    expect(getDraft(draftKey.thread("conv-a"))).toBe("");
    expect(getDraft(draftKey.thread("conv-b"))).toBe("draft for B");
    /* Text typed during the flight isn't part of the send — keep it. */
    setDraft(draftKey.thread("conv-a"), "sent from A + more typing");
    clearDraftIfSent(draftKey.thread("conv-a"), "sent from A");
    expect(getDraft(draftKey.thread("conv-a"))).toBe(
      "sent from A + more typing",
    );
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

describe("draft send key (#552)", () => {
  test("AC-1 a resend of the same draft reuses its key — the key belongs to the draft, not the tap", () => {
    const key = draftKey.thread("conv-a");
    setDraft(key, "did that land?");
    const first = draftSendKey(key);
    expect(first).toMatch(/^u-/);
    /* The failed send kept the draft — the resend must repeat the key or
       the relay can't dedupe the stored-but-unanswered first attempt. */
    expect(draftSendKey(key)).toBe(first);
  });

  test("AC-1 editing the draft mints a fresh key; clearing drops it", () => {
    const key = draftKey.dm("emp-1");
    setDraft(key, "first wording");
    const first = draftSendKey(key);
    /* Edited text is a new send — never a dedupe hit on the old one. */
    setDraft(key, "first wording, edited");
    expect(draftSendKey(key)).not.toBe(first);
    /* A cleared draft loses its key; re-typing the same words is a new
       send (deliberate re-posts are allowed). */
    const second = draftSendKey(key);
    clearDraft(key);
    setDraft(key, "first wording, edited");
    expect(draftSendKey(key)).not.toBe(second);
  });

  test("AC-1 a draft saved before #552 (plain text) still reads, then carries a key", () => {
    const key = draftKey.thread("conv-legacy");
    localStorage.setItem(`lilos:composer-draft:${key}`, "pre-envelope draft");
    expect(getDraft(key)).toBe("pre-envelope draft");
    const k = draftSendKey(key);
    expect(draftSendKey(key)).toBe(k);
    expect(getDraft(key)).toBe("pre-envelope draft");
  });

  test("AC-1 a draft that starts with '{' is text, not an envelope", () => {
    const key = draftKey.thread("conv-brace");
    /* Typed JSON or a malformed envelope must read back as the draft,
       never parse-eat it (and draftSendKey mustn't wipe it). */
    setDraft(key, '{"cmd":"build"}');
    expect(getDraft(key)).toBe('{"cmd":"build"}');
    const k = draftSendKey(key);
    expect(draftSendKey(key)).toBe(k);
    expect(getDraft(key)).toBe('{"cmd":"build"}');
    localStorage.setItem(`lilos:composer-draft:${key}`, "{not json");
    expect(getDraft(key)).toBe("{not json");
    /* Valid JSON that isn't an envelope reads back as the draft too. */
    localStorage.setItem(`lilos:composer-draft:${key}`, '{"a":1}');
    expect(getDraft(key)).toBe('{"a":1}');
  });
});
