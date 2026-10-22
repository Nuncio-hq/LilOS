// @vitest-environment happy-dom
/* The stuck card's "The CEO will handle it." is a flash in the e2e: the
   wake can hand the thread off before the page paints it. The sentence
   and when it shows live here (D-#777). */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Actions } from "../src/v3/v3-page-types";
import { ThreadCard } from "../src/v3/v3-thread-card";
import type { V3Agent, V3Thread } from "../src/v3/v3-types";

afterEach(cleanup);

const NOTICE = "The CEO will handle it.";

const agent = (id: string, name: string): V3Agent => ({
  id,
  name,
  tone: "b",
  role: "Engineer",
  hired: "1 Oct",
  model: "Model",
  instructions: [],
});

const stuck = (over: Partial<V3Thread> = {}): V3Thread => ({
  id: "t1",
  ticketId: "ACME-1",
  agentId: "bea",
  title: "Stuck step",
  status: "stuck",
  startedAt: "09:00",
  minutes: 4,
  turns: [],
  stuck: { what: "Same web search 6 times", detail: [] },
  ...over,
});

function data(over: Partial<V3Data> = {}): V3Data {
  return {
    company: "Co",
    me: "Ada",
    today: "Wednesday",
    ceoId: "ada",
    agents: [agent("ada", "Ada"), agent("bea", "Bea")],
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
    hireTemplates: [],
    settings: {
      approvals: "ask",
      models: [],
      engine: { name: "Engine", state: "ok" },
      relay: { state: "ok" },
    },
    setUp: true,
    features: { tickets: true },
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
  }) as unknown as V3Actions;

function card(d: V3Data, t: V3Thread) {
  render(<ThreadCard t={t} data={d} go={vi.fn()} act={act()} />);
}

describe("stuck card, the CEO sentence", () => {
  test("a stuck ticket someone else can take says the CEO will handle it", () => {
    card(data(), stuck());
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  test("the sentence stays off unless every part of the rule holds", () => {
    /* Not stuck: a failed card shares the branch and still has no sentence. */
    card(data(), stuck({ status: "failed" }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    /* A chat, not a ticket. */
    card(data(), stuck({ ticketId: undefined }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    /* No one holds the CEO position. */
    card(data({ ceoId: undefined }), stuck());
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    /* The CEO's own thread. */
    card(data(), stuck({ agentId: "ada" }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    /* Nobody else is on the roster, so nobody can take it. */
    card(data({ agents: [agent("bea", "Bea")] }), stuck());
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
