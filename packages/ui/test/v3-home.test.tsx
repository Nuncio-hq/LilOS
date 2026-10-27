// @vitest-environment happy-dom
/* Home reads the same counts, idle set and finished rows as Threads and
   Needs you (D-#774). One agent with two working threads counts as two. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data, V3Schedule } from "../src/v3/v3-data-types";
import { V3Home } from "../src/v3/v3-home";
import {
  asleepAgents,
  nextRunLabel,
  resultsToLookAt,
  threadsIn,
} from "../src/v3/v3-model";
import { OpenRecord } from "../src/v3/v3-open-record";
import type { V3Actions } from "../src/v3/v3-page-types";
import type { V3Agent, V3Thread, V3Ticket } from "../src/v3/v3-types";

afterEach(cleanup);

/** "2 working" is a <b> beside the word, so the node's text is split. */
const isCount = (el: Element | null, n: number, word: string) =>
  el?.tagName === "SPAN" &&
  el.firstElementChild?.tagName === "B" &&
  (el.textContent ?? "").replace(/\s+/g, " ").trim() === `${n} ${word}`;
const shows = (n: number, word: string) =>
  screen.getByText((_, el) => isCount(el, n, word));
const hides = (n: number, word: string) => {
  expect(screen.queryByText((_, el) => isCount(el, n, word))).toBeNull();
};

const agent = (id: string, name: string): V3Agent => ({
  id,
  name,
  tone: "b",
  role: "Engineer",
  hired: "1 Oct",
  model: "Model",
  instructions: [],
});

const thread = (
  p: Partial<V3Thread> & Pick<V3Thread, "id" | "status">,
): V3Thread => ({
  agentId: "ada",
  title: p.id,
  startedAt: "09:00",
  minutes: 4,
  turns: [],
  ...p,
});

const schedule = (
  p: Partial<V3Schedule> & Pick<V3Schedule, "id" | "next">,
): V3Schedule => ({
  agentId: "ada",
  title: "Morning triage",
  prompt: "Check overnight",
  when: { kind: "weekdays", time: "09:00" },
  ...p,
});

function data(over: Partial<V3Data> = {}): V3Data {
  return {
    company: "Co",
    me: "Ada",
    today: "Wednesday",
    agents: [agent("ada", "Ada")],
    connectors: [],
    projects: [],
    goals: [],
    tickets: [],
    threads: [],
    asks: [],
    updates: [],
    schedules: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
    modelChoices: [],
    settings: {
      approvals: "ask",
      models: [],
      engine: { name: "Engine", state: "ok" },
      relay: { state: "ok" },
    },
    setUp: true,
    features: { tickets: false },
    ...over,
  };
}

const act = () =>
  ({
    approve: vi.fn(),
    deny: vi.fn(),
    answer: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    startChat: vi.fn(async () => undefined),
    markSeen: vi.fn(),
  }) as unknown as V3Actions & {
    approve: ReturnType<typeof vi.fn>;
    markSeen: ReturnType<typeof vi.fn>;
  };

describe("Home counts and rows", () => {
  test("working and needs-you count threads, idle counts agents off the board, stuck stays hidden at zero", () => {
    const d = data({
      agents: [agent("ada", "Ada"), agent("bea", "Bea")],
      threads: [
        thread({ id: "t1", status: "working", title: "Release note" }),
        thread({ id: "t2", status: "working", title: "Footer" }),
        thread({ id: "t3", agentId: "bea", status: "needs", title: "Ship it" }),
      ],
    });
    render(<V3Home data={d} go={vi.fn()} act={act()} />);
    expect(threadsIn(d.threads, "working")).toBe(2);
    expect(shows(2, "working")).toBeTruthy();
    hides(1, "working");
    expect(shows(1, "needs you")).toBeTruthy();
    expect(asleepAgents(d)).toEqual([]);
    expect(screen.queryByText(/idle/i)).toBeNull();
    expect(screen.queryByText(/stuck/i)).toBeNull();
    expect(screen.queryByText("Waiting on")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Recent results" }),
    ).toBeNull();
  });

  test("an idle row names the soonest schedule, and a live row names its thread", () => {
    const d = data({
      agents: [agent("ada", "Ada"), agent("bea", "Bea")],
      schedules: [
        schedule({
          id: "later",
          next: "Tomorrow 09:00",
          title: "Later",
          nextAt: 2_000,
        }),
        schedule({
          id: "soon",
          next: "Today 08:00",
          title: "Morning triage",
          nextAt: 1_000,
        }),
        schedule({
          id: "paused",
          next: "Today 01:00",
          title: "Paused",
          paused: true,
          nextAt: 100,
        }),
      ],
      threads: [
        thread({
          id: "t1",
          agentId: "bea",
          status: "working",
          title: "Release note",
          minutes: 0,
        }),
      ],
    });
    expect(nextRunLabel(d, "ada")).toBe("Morning triage · Today 08:00");
    render(<V3Home data={d} go={vi.fn()} act={act()} />);
    expect(screen.getByText("Morning triage · Today 08:00")).toBeTruthy();
    expect(screen.getByText("Release note")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(shows(1, "idle")).toBeTruthy();
    expect(shows(1, "working")).toBeTruthy();
  });

  test("recent results are Needs you's rows, and approve does not open the row", () => {
    const ticket = {
      id: "HB-1",
      title: "Old ticket",
      projectId: "p",
      owner: "ada",
      status: "done",
      since: 10,
      doneAgo: 10,
      progress: [],
      updates: [],
    } as V3Ticket;
    const d = data({
      tickets: [ticket],
      threads: [
        thread({
          id: "seen",
          status: "done",
          title: "Already seen",
          summary: "done",
        }),
        thread({
          id: "fresh",
          status: "done",
          title: "Add a footer",
          unseen: true,
          doneAgo: 1,
          summary: "Shipped",
        }),
      ],
      asks: [
        {
          id: "ask-1",
          threadId: "fresh",
          from: "ada",
          kind: "approval",
          /* #884: the ask's own line is the plain sentence; the row names
             the thread instead. */
          title: "Edit README.md?",
          waiting: 2,
          at: 1,
          ask: "patch README.md",
        },
      ],
    });
    const rows = resultsToLookAt(d);
    expect(rows.map((r) => r.title)).toEqual(["Add a footer", "Old ticket"]);
    expect(rows.find((r) => r.title === "Already seen")).toBeUndefined();

    const go = vi.fn();
    const actions = act();
    render(
      <OpenRecord.Provider value={{ page: "thread", id: "fresh" }}>
        <V3Home data={d} go={go} act={actions} />
      </OpenRecord.Provider>,
    );
    /* #884: "Add a footer" names two rows now — the needs-you row and the
       result row; only the result carries aria-current. */
    const footerRows = screen.getAllByRole("button", { name: /Add a footer/ });
    const openResult = footerRows.find(
      (b) => b.getAttribute("aria-current") === "true",
    );
    expect(openResult).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Old ticket/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: /Recent results/ }),
    ).toBeTruthy();
    expect(screen.getAllByText("Add a footer").length).toBeGreaterThan(0);
    expect(screen.queryByText("Already seen")).toBeNull();
    expect(screen.getByText("Old ticket")).toBeTruthy();

    // The needs-you row names the thread and asks the sentence (#884).
    expect(screen.getByText(/Edit README\.md\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(actions.approve).toHaveBeenCalledWith("ask-1");
    expect(go).not.toHaveBeenCalled();

    fireEvent.click(openResult as HTMLElement);
    expect(actions.markSeen).toHaveBeenCalledWith("fresh");
    expect(go).toHaveBeenCalledWith({ page: "thread", id: "fresh" });
  });
});
