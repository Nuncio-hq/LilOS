// @vitest-environment happy-dom
/* #719: the page wires Composer CONTROLLED via useDraft — the existing #130
   tests only exercise the uncontrolled path. This mounts the real draft
   store + a sendInThread-shaped rejecting send. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import { draftKey, useDraft } from "../src/lib/drafts";

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

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function ThreadHost({
  convId,
  onSend,
  reconnecting = false,
}: {
  convId: string | undefined;
  onSend: (t: string, files?: unknown[]) => Promise<unknown>;
  reconnecting?: boolean;
}) {
  const [threadDraft, setThreadDraft] = useDraft(
    convId ? draftKey.thread(convId) : undefined,
  );
  return (
    <div>
      {reconnecting && <div data-reconnecting>Reconnecting…</div>}
      {convId && (
        <Composer
          placeholder="Reply…"
          employees={[]}
          hint=""
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          onSend={onSend}
          accept="image/*"
        />
      )}
    </div>
  );
}

const box = (r: HTMLElement) =>
  r.querySelector("textarea") as HTMLTextAreaElement;
const formOf = (r: HTMLElement) => r.querySelector("form") as HTMLFormElement;
const attach = (r: HTMLElement, name = "pic.png") => {
  const input = r.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["png"], name, { type: "image/png" })] },
  });
};

describe("issue #719 controlled composer + useDraft", () => {
  test("rejected send keeps draft text and chips (controlled)", async () => {
    localStorage.clear();
    let rejectSend: (e: Error) => void = () => {};
    const onSend = vi.fn(
      () => new Promise<never>((_, rej) => (rejectSend = rej)),
    );
    const r = render(<ThreadHost convId="conv1" onSend={onSend} />);
    fireEvent.change(box(r.container), { target: { value: "kept" } });
    attach(r.container);
    fireEvent.submit(formOf(r.container));
    await settle();
    rejectSend(new Error("refused"));
    await settle();
    expect(box(r.container).value).toBe("kept");
    expect(r.container.textContent).toContain("pic.png");
  });
});
