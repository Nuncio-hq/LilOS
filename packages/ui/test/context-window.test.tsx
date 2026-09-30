// @vitest-environment happy-dom
/* AC tests for issue #294 — one session, one context window, one %:
   the DM thread panel and Focus resolve the session's model through the
   same helper and divide by the engine-reported window; a model with no
   reported window falls back to the labelled estimate (`~`). */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import {
  contextWindowOf,
  FALLBACK_CONTEXT_WINDOW,
  sessionModelId,
} from "../src/lib/context-window";
import { ThreadView } from "../src/thread/thread-view";
import type {
  Channel,
  EmpFn,
  HumanFn,
  ModelOption,
  Msg,
  Reply,
  Thread,
} from "../src/types";

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
afterEach(cleanup);

/* The reported repro: the employee's own model isn't the session's — 94,800
   used is 47.4% of a 200k window (the employee's) vs 36.2% of the session's
   real 262k one. */
const BUILDER = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = () => ({ name: "Ada", color: "bg-blue-600" });

const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "hi",
};
const agentTurn: Reply = {
  id: "r1",
  from: "builder",
  time: "10:04",
  text: "done",
};
const dmChannel: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
/* The engine's catalog: the session model reports 262k, the employee's model
   reports a different 200k — wrong-model reads diverge, right-model reads
   agree. */
const catalog: ModelOption[] = [
  { id: "fake-small", name: "Fake Small", contextWindow: 200_000 },
  {
    id: "qwen3.8-flash-next",
    name: "Qwen3.8 Flash Next",
    contextWindow: 262_000,
  },
];
const usage = { input: 94_800, output: 0, reasoning: 0, cache: 0 };

const sessionThread: Thread = {
  session: "s_repro",
  model: "qwen3.8-flash-next",
  replies: [agentTurn],
  queue: [],
  usage,
};

const percents = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("span"))
    .map((s) => s.textContent?.trim() ?? "")
    .filter((t) => /^\d+(\.\d+)?%$/.test(t));

const props = {
  root,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  onSend: () => {},
  models: catalog,
} as const;

describe("issue #294 — one session reads the same window everywhere", () => {
  test("sessionModelId prefers the session pin, then the employee, then the engine default", () => {
    const t = { model: "qwen3.8-flash-next" };
    expect(sessionModelId(t, "fake-small", catalog)).toBe("qwen3.8-flash-next");
    expect(sessionModelId({}, "fake-small", catalog)).toBe("fake-small");
    expect(sessionModelId({}, "", catalog, "qwen3.8-flash-next")).toBe(
      "qwen3.8-flash-next",
    );
    expect(sessionModelId({}, "", catalog)).toBe("fake-small");
  });

  test("contextWindowOf: the session's reported window beats the catalog, the catalog beats the estimate", () => {
    // Engine-reported on the usage — the resolved window wins outright.
    expect(
      contextWindowOf(
        { ...usage, contextWindow: 128_000 },
        "fake-small",
        catalog,
      ),
    ).toEqual({ tokens: 128_000, estimated: false });
    // No report on the usage → the session model's catalog row.
    expect(contextWindowOf(usage, "qwen3.8-flash-next", catalog)).toEqual({
      tokens: 262_000,
      estimated: false,
    });
    // Nothing reported anywhere → the labelled estimate; qwen keeps its
    // pre-#294 hint, everything else the plain fallback.
    expect(contextWindowOf(usage, "qwen3.8-flash-next")).toEqual({
      tokens: 262_000,
      estimated: true,
    });
    expect(contextWindowOf(usage, "fake/opus-2", catalog)).toEqual({
      tokens: FALLBACK_CONTEXT_WINDOW,
      estimated: true,
    });
    expect(contextWindowOf(usage, undefined)).toEqual({
      tokens: FALLBACK_CONTEXT_WINDOW,
      estimated: true,
    });
  });

  test("the thread panel resolves the session's model, never the employee's", () => {
    const panel = render(
      <ThreadView
        {...props}
        thread={sessionThread}
        channel={dmChannel}
        repo="Nuncio-hq/LilOS"
      />,
    );
    // Session model's 262k → 36.2%; the employee's 200k would have shown 47.4%.
    expect(percents(panel.container)).toContain("36.2%");
    expect(percents(panel.container)).not.toContain("47.4%");
  });

  test("the DM panel and Focus show the same % for the same session", () => {
    const panel = render(
      <ThreadView
        {...props}
        thread={sessionThread}
        channel={dmChannel}
        repo="Nuncio-hq/LilOS"
      />,
    );
    const focus = render(
      <FocusView {...props} thread={sessionThread} channel={dmChannel} />,
    );
    expect(percents(panel.container)).toEqual(percents(focus.container));
    expect(percents(focus.container)).toContain("36.2%");
  });

  test("an engine-reported window on the usage beats the catalog at both surfaces", () => {
    const reported: Thread = {
      ...sessionThread,
      usage: { ...usage, contextWindow: 100_000 },
    };
    const panel = render(
      <ThreadView
        {...props}
        thread={reported}
        channel={dmChannel}
        repo="Nuncio-hq/LilOS"
      />,
    );
    const focus = render(
      <FocusView {...props} thread={reported} channel={dmChannel} />,
    );
    // 94,800 / 100,000 = 94.8% — neither model's catalog window is used.
    expect(percents(panel.container)).toEqual(percents(focus.container));
    expect(percents(focus.container)).toContain("94.8%");
  });
});
