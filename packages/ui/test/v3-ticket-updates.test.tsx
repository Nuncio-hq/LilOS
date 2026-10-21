// @vitest-environment happy-dom
/* A system note is LilOS, not a person. Hand to… needs someone to hand to.
   An ask on a ticket is found by the ticket, because the wait stores no ask id. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3Home } from "../src/v3/v3-home";
import { V3Needs } from "../src/v3/v3-needs";
import type { V3Actions } from "../src/v3/v3-page-types";
import { V3TicketPage } from "../src/v3/v3-ticket";
import { AskNote, TicketMoves } from "../src/v3/v3-ticket-notes";
import type { V3Agent, V3Ticket } from "../src/v3/v3-types";

afterEach(cleanup);

const agent = (id: string, name: string): V3Agent => ({
  id,
  name,
  tone: "b",
  role: "Engineer",
  hired: "1 Oct",
  model: "Model",
  instructions: [],
});

const act = (over: Partial<V3Actions> = {}) =>
  ({
    approve: vi.fn(),
    deny: vi.fn(),
    answer: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    ask: vi.fn(),
    startChat: vi.fn(async () => undefined),
    markSeen: vi.fn(),
    handOff: vi.fn(),
    markDone: vi.fn(),
    comment: vi.fn(),
    ...over,
  }) as V3Actions;

function company(over: Partial<V3Data> = {}): V3Data {
  return {
    company: "Co",
    me: "Oscar",
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

const ticket = (over: Partial<V3Ticket> = {}): V3Ticket => ({
  id: "LIL-2",
  title: "After the blocker",
  projectId: "p",
  owner: "ada",
  status: "working",
  since: 1,
  progress: [],
  updates: [
    {
      authorKind: "system",
      ago: 0,
      text: "LIL-1 is done, so this can move.",
    },
    { authorKind: "user", by: "you", ago: 5, text: "Looked at it" },
  ],
  ...over,
});

describe("ticket updates", () => {
  test("a system note has no name and no face; a person still does", () => {
    render(
      <V3TicketPage
        data={company({ tickets: [ticket()] })}
        go={vi.fn()}
        act={act()}
        id="LIL-2"
      />,
    );
    const system = screen.getByText("LIL-1 is done, so this can move.");
    expect(system.parentElement?.textContent).toContain("just now");
    expect(system.parentElement?.textContent).not.toContain("Oscar");
    expect(system.parentElement?.textContent).not.toContain("Ada");
    expect(system.parentElement?.querySelector("span[aria-hidden]")).toBeNull();
    const person = screen.getByText("Looked at it");
    expect(person.parentElement?.textContent).toContain("Oscar");
    expect(person.parentElement?.textContent).toContain("5m ago");
  });

  test("Hand to… is absent when nobody can take the ticket", () => {
    const t = ticket({ status: "working" });
    const { rerender } = render(
      <TicketMoves data={company({ agents: [] })} t={t} act={act()} />,
    );
    expect(screen.queryByRole("button", { name: "Hand to …" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
    rerender(<TicketMoves data={company()} t={t} act={act()} />);
    expect(screen.getByRole("button", { name: "Hand to …" })).toBeTruthy();
  });

  test("an ask on the ticket shows even when the wait stores no ask id", () => {
    const t = ticket({
      status: "needs",
      waitingOn: { kind: "you", askId: "" },
    });
    render(
      <AskNote
        data={company({
          tickets: [t],
          asks: [
            {
              id: "ask-9",
              ticketId: "LIL-2",
              from: "ada",
              kind: "question",
              title: "Which name?",
              waiting: 2,
              ask: "Keep one name?",
              options: ["Keep it", "Rename"],
            },
          ],
        })}
        t={t}
        act={act()}
      />,
    );
    expect(screen.getByText("Keep one name?")).toBeTruthy();
  });

  test("an unassigned done or stuck ticket says Unassigned, not Former agent", () => {
    const done: V3Ticket = {
      ...ticket({
        id: "LIL-9",
        title: "Nobody's ticket",
        owner: "",
        status: "done",
        doneAgo: 10,
        updates: [],
      }),
    };
    const stuck: V3Ticket = {
      ...ticket({
        id: "LIL-8",
        title: "Stuck with nobody",
        owner: "",
        status: "stuck",
        stuckWhy: "same step",
        fallback: { at: "15:00", does: "hands it on" },
        updates: [],
      }),
    };
    const data = company({ agents: [], tickets: [done, stuck] });
    const { unmount } = render(
      <V3Needs data={data} go={vi.fn()} act={act()} />,
    );
    expect(screen.getByText(/Nobody's ticket/)).toBeTruthy();
    expect(screen.getByText(/Stuck with nobody/)).toBeTruthy();
    expect(screen.getAllByText(/Unassigned/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Former agent")).toBeNull();
    unmount();
    render(<V3Home data={data} go={vi.fn()} act={act()} />);
    expect(screen.getByText(/Nobody's ticket/)).toBeTruthy();
    expect(screen.queryByText("Former agent")).toBeNull();
  });
});
