// @vitest-environment happy-dom
/* #532 AC-2: the transcript note's KIND pins its position — "trimmed"
   (#431, history missing above the first entry) heads the transcript in
   both ThreadView and FocusView; "unavailable" (#28, the live tail can't
   replay) stays after the entries. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import { ThreadView } from "../src/thread/thread-view";
import type {
  Channel,
  EmpFn,
  HumanFn,
  Msg,
  Reply,
  Thread,
  TranscriptNote,
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
  id === "ada" ? { name: "Ada", color: "bg-blue-600" } : undefined;

const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "@builder continue the harness work",
};
const turns: Reply[] = [
  {
    id: "r1",
    from: "builder",
    time: "10:04",
    text: "Picked it back up.",
    phase: "done",
  },
  { id: "r2", from: "ada", time: "10:05", text: "thanks" },
  { id: "r3", from: "builder", time: "10:06", text: "Done.", phase: "done" },
];
const thread: Thread = { session: "s_trimmed", replies: turns };
const channel: Channel = {
  id: "eng",
  name: "engineering",
  employees: ["builder"],
  repo: "Nuncio-hq/LilOS",
};

const panelProps = {
  root,
  thread,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  repo: channel.repo,
  onSend: () => {},
} as const;
const focusProps = {
  root,
  thread,
  channel,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  onSend: () => {},
} as const;

const TRIMMED: TranscriptNote = {
  kind: "trimmed",
  text: "Earlier history was trimmed — this session's event log is capped.",
};
const UNAVAILABLE: TranscriptNote = {
  kind: "unavailable",
  text: "Working transcript unavailable — the engine feed is disconnected",
};

const note = (c: HTMLElement) => c.querySelector("[data-transcript-note]");
const entries = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-msg]"));
const precedes = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("issue #532 — transcript note kind decides head vs tail", () => {
  test("trimmed note heads the transcript in ThreadView", () => {
    const c = render(
      <ThreadView {...panelProps} channel={channel} transcriptNote={TRIMMED} />,
    );
    const n = note(c.container);
    const es = entries(c.container);
    expect(n).not.toBeNull();
    expect(es.length).toBeGreaterThan(0);
    expect(n?.getAttribute("data-kind")).toBe("trimmed");
    /* Before the first entry — the missing history sits above it. */
    expect(precedes(n as Element, es[0])).toBe(true);
    expect(n?.textContent).toContain("Earlier history was trimmed");
  });

  test("trimmed note heads the transcript in FocusView", () => {
    const c = render(<FocusView {...focusProps} transcriptNote={TRIMMED} />);
    const n = note(c.container);
    const es = entries(c.container);
    expect(n).not.toBeNull();
    expect(es.length).toBeGreaterThan(0);
    expect(n?.getAttribute("data-kind")).toBe("trimmed");
    expect(precedes(n as Element, es[0])).toBe(true);
  });

  test("unavailable note stays after the entries in ThreadView", () => {
    const c = render(
      <ThreadView
        {...panelProps}
        channel={channel}
        transcriptNote={UNAVAILABLE}
      />,
    );
    const n = note(c.container);
    const es = entries(c.container);
    expect(n).not.toBeNull();
    expect(n?.getAttribute("data-kind")).toBe("unavailable");
    /* After the last entry — it describes the tail that can't replay (#28). */
    expect(precedes(es[es.length - 1], n as Element)).toBe(true);
  });

  test("unavailable note stays after the entries in FocusView", () => {
    const c = render(
      <FocusView {...focusProps} transcriptNote={UNAVAILABLE} />,
    );
    const n = note(c.container);
    const es = entries(c.container);
    expect(n).not.toBeNull();
    expect(n?.getAttribute("data-kind")).toBe("unavailable");
    expect(precedes(es[es.length - 1], n as Element)).toBe(true);
  });

  test("no note renders without the prop", () => {
    const panel = render(<ThreadView {...panelProps} channel={channel} />);
    const focus = render(<FocusView {...focusProps} />);
    expect(note(panel.container)).toBeNull();
    expect(note(focus.container)).toBeNull();
  });
});
