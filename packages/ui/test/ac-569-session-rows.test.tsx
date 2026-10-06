// @vitest-environment happy-dom
/* Issue #569 — a word streaming into one session must not re-render the
   other sessions' DM rows. The session row is a React.memo component on
   the app's stable folded Msg, and preview()/inline() parse each distinct
   text once (cache by text — the streaming row's preview must not re-run
   markdown for every delta that lands). */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EmpFn, Employee, HumanFn, Msg, WsPick } from "../src/types";

/* Body render count = how many session rows re-rendered. */
const counts = vi.hoisted(() => ({ body: 0, parses: 0 }));

vi.mock("../src/feed/row", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/feed/row")>();
  return {
    ...orig,
    Body: ({ text }: { text: string }) => {
      counts.body++;
      return <orig.Body text={text} />;
    },
  };
});

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("mdast-util-from-markdown")>();
  return {
    ...orig,
    fromMarkdown: (...args: Parameters<typeof orig.fromMarkdown>) => {
      counts.parses++;
      return orig.fromMarkdown(...args);
    },
  };
});

import { EmployeeHome } from "../src/employee/employee-home";
import { inline, preview } from "../src/lib/helpers";

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
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });

afterEach(cleanup);
afterEach(() => localStorage.clear());

const EMP: Employee = {
  id: "e1",
  name: "Builder",
  role: "Engineer",
  status: "online",
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone",
};
const emp: EmpFn = (id) => (id === "e1" ? EMP : undefined);
const human: HumanFn = () => undefined;
const NO_WS: WsPick = { folder: null, base: "main", mode: "new" };

type SessionMsg = Extract<Msg, { kind: "msg" }>;

/** One session row's feed Msg: root question + one employee answer so the
    row renders the preview line. */
const session = (
  n: number,
  answer = "**Answer** with `code_x`",
): SessionMsg => ({
  kind: "msg",
  id: `m${n}`,
  from: "user",
  time: "10:42",
  text: `Question ${n}`,
  thread: {
    session: `ses_${n}`,
    replies: [{ id: `r${n}`, from: "e1", time: "10:42", text: answer }],
  },
});

const props = (feed: Msg[]) => ({
  e: EMP,
  feed,
  threadId: null,
  emp,
  human,
  onNav: () => {},
  onProfile: () => {},
  onOpen: () => {},
  onSend: () => {},
  panelOpen: false,
  onPanel: () => {},
  folders: [],
  pick: NO_WS,
  setPick: () => {},
});

/** The fold's contract: a delta rebuilds ONLY that session's Msg — the
    other rows' Msgs keep their object identity (FoldCache). */
const grown = (m: Msg, text: string): SessionMsg => {
  const s = m as SessionMsg;
  if (!s.thread) throw new Error("session msg without thread");
  return {
    ...s,
    thread: {
      ...s.thread,
      replies: [
        ...s.thread.replies,
        { id: "live", from: "e1", time: "", text, live: true },
      ],
    },
  };
};

describe("issue #569 — DM session rows", () => {
  test("AC-1 a streamed word into one session re-renders only its own row", () => {
    const N = 8;
    const feed: Msg[] = Array.from({ length: N }, (_, i) => session(i));
    const { rerender } = render(<EmployeeHome {...props(feed)} />);
    /* Every row rendered once on mount — that is not what is measured. */
    counts.body = 0;
    counts.parses = 0;

    /* A delta lands in session 3. */
    const feed2 = feed.map((m, i) => (i === 3 ? grown(m, "streaming…") : m));
    rerender(<EmployeeHome {...props(feed2)} />);

    /* Before the fix the inline row builder re-rendered every row per
       delta (N bodies + N markdown previews per streamed word). */
    expect(counts.body).toBe(1);
    /* The streamed row re-rendered but its preview text is unchanged —
       the text-keyed cache means no re-parse at all this delta. */
    expect(counts.parses).toBe(0);
  });

  test("AC-1 the changed row still shows the new reply", () => {
    const feed: Msg[] = [session(1), session(2)];
    const { rerender, container } = render(<EmployeeHome {...props(feed)} />);
    rerender(
      <EmployeeHome {...props([grown(feed[0], "new reply"), feed[1]])} />,
    );
    const row = container.querySelector('[data-session="m1"]');
    expect(row?.textContent).toContain("2 replies");
  });

  test("AC-1 preview()/inline() parse each distinct text once", () => {
    counts.parses = 0;
    expect(preview("**uniq-a** _em_")).toBe("uniq-a em");
    expect(preview("**uniq-a** _em_")).toBe("uniq-a em");
    expect(preview("**uniq-b**")).toBe("uniq-b");
    /* Three distinct texts, each parsed once — repeats served from cache. */
    const afterPreview = counts.parses;
    expect(afterPreview).toBe(2);
    preview("**uniq-a** _em_");
    preview("**uniq-b**");
    expect(counts.parses).toBe(2);

    expect(inline("## uniq-c `x_y`")).toBe("uniq-c x_y");
    expect(inline("## uniq-c `x_y`")).toBe("uniq-c x_y");
    expect(counts.parses).toBe(3);
  });
});
