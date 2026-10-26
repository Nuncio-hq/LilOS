/* The #863 split-view rules, decided with the owner (26 Oct 2026): the
   sidebar and ⌘K NAVIGATE — the target becomes the page, full width, and
   any peek closes; an item on the page opens in the side PEEK only when
   the page lists it (a thread row on its project, a helper on its parent
   thread); a link inside the peek extends its trail; the expand widens
   the peek as before. The URL codec keeps the record-as-page form:
   `page=<kind>&id=<id>`. */
import { describe, expect, test } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { navFromParams, paramsFromNav, step } from "../src/v3/v3-nav";
import type { V3Nav, V3Route } from "../src/v3/v3-page-types";
import type { V3Agent, V3Thread, V3Ticket } from "../src/v3/v3-types";

const agent = (id: string): V3Agent => ({
  id,
  name: id,
  tone: "b",
  role: "Engineer",
  hired: "1 Oct",
  model: "Model",
  instructions: [],
});

const thread = (p: Partial<V3Thread> & Pick<V3Thread, "id">): V3Thread => ({
  agentId: "ada",
  title: p.id,
  status: "working",
  startedAt: "09:00",
  minutes: 4,
  turns: [],
  ...p,
});

const ticket = (p: Partial<V3Ticket> & Pick<V3Ticket, "id">): V3Ticket => ({
  title: p.id,
  projectId: "p1",
  owner: "ada",
  status: "working",
  since: 3,
  progress: [],
  updates: [],
  ...p,
});

const data = (over: Partial<V3Data> = {}): V3Data =>
  ({
    agents: [agent("ada"), agent("bea")],
    projects: [
      { id: "p1", name: "P1", key: "P1", tone: "b", folder: "~/p1", about: "" },
      { id: "p2", name: "P2", key: "P2", tone: "r", folder: "~/p2", about: "" },
    ],
    goals: [{ id: "g1", title: "G1", projectId: "p1", due: "Fri", why: "" }],
    tickets: [ticket({ id: "LIL-1" }), ticket({ id: "LIL-2", goalId: "g1" })],
    threads: [
      thread({ id: "t1", projectId: "p1" }),
      thread({ id: "t2", projectId: "p2", agentId: "bea" }),
      thread({ id: "t-h1", parentId: "t1" }),
      thread({ id: "t-tick", ticketId: "LIL-1" }),
    ],
    features: { tickets: true },
    ...over,
  }) as V3Data;

const d = data();
const on = (page: V3Route, peek: V3Nav["peek"] = []): V3Nav => ({ page, peek });

describe("sidebar and ⌘K navigate (#863)", () => {
  test("a sidebar page becomes the page and closes the peek", () => {
    const nav = on({ page: "project", id: "p1" }, [
      { page: "thread", id: "t1" },
    ]);
    expect(step(nav, { page: "threads" }, "nav", d)).toEqual({
      page: { page: "threads" },
      peek: [],
    });
  });

  test("a sidebar project or agent becomes the page itself", () => {
    const nav = on({ page: "threads" }, [{ page: "thread", id: "t1" }]);
    expect(step(nav, { page: "project", id: "p1" }, "nav", d)).toEqual({
      page: { page: "project", id: "p1" },
      peek: [],
    });
    expect(step(nav, { page: "agent", id: "bea" }, "nav", d)).toEqual({
      page: { page: "agent", id: "bea" },
      peek: [],
    });
  });

  test("a ⌘K record jump navigates too — no more project left, unrelated record right", () => {
    const nav = on({ page: "project", id: "p1" });
    expect(step(nav, { page: "agent", id: "bea" }, "nav", d)).toEqual({
      page: { page: "agent", id: "bea" },
      peek: [],
    });
  });
});

describe("an item on the page peeks only when the page lists it", () => {
  test("a thread row on its project page opens beside the project", () => {
    const nav = on({ page: "project", id: "p1" });
    expect(step(nav, { page: "thread", id: "t1" }, "page", d)).toEqual({
      page: { page: "project", id: "p1" },
      peek: [{ page: "thread", id: "t1" }],
    });
  });

  test("another project's thread on the page navigates instead", () => {
    const nav = on({ page: "project", id: "p1" });
    expect(step(nav, { page: "thread", id: "t2" }, "page", d)).toEqual({
      page: { page: "thread", id: "t2" },
      peek: [],
    });
  });

  test("a thread on Home or Threads opens beside", () => {
    for (const page of [
      { page: "home" },
      { page: "threads" },
      { page: "needs" },
    ] as V3Route[]) {
      expect(step(on(page), { page: "thread", id: "t2" }, "page", d)).toEqual({
        page,
        peek: [{ page: "thread", id: "t2" }],
      });
    }
  });

  test("a helper on its parent thread's page opens beside it", () => {
    const nav = on({ page: "thread", id: "t1" });
    expect(step(nav, { page: "thread", id: "t-h1" }, "page", d)).toEqual({
      page: { page: "thread", id: "t1" },
      peek: [{ page: "thread", id: "t-h1" }],
    });
  });

  test("the parent a helper belongs to is context: it navigates", () => {
    const nav = on({ page: "thread", id: "t-h1" });
    expect(step(nav, { page: "thread", id: "t1" }, "page", d)).toEqual({
      page: { page: "thread", id: "t1" },
      peek: [],
    });
  });

  test("a thread on its agent's page opens beside", () => {
    const nav = on({ page: "agent", id: "bea" });
    expect(step(nav, { page: "thread", id: "t2" }, "page", d)).toEqual({
      page: { page: "agent", id: "bea" },
      peek: [{ page: "thread", id: "t2" }],
    });
  });

  test("a ticket on Work and a hand on its ticket open beside", () => {
    expect(
      step(on({ page: "work" }), { page: "ticket", id: "LIL-1" }, "page", d),
    ).toEqual({
      page: { page: "work" },
      peek: [{ page: "ticket", id: "LIL-1" }],
    });
    expect(
      step(
        on({ page: "ticket", id: "LIL-1" }),
        { page: "thread", id: "t-tick" },
        "page",
        d,
      ),
    ).toEqual({
      page: { page: "ticket", id: "LIL-1" },
      peek: [{ page: "thread", id: "t-tick" }],
    });
  });

  test("a project's goals and tickets belong to it; an agent link is a place you go", () => {
    const nav = on({ page: "project", id: "p1" });
    for (const r of [
      { page: "goal", id: "g1" },
      { page: "ticket", id: "LIL-1" },
    ] as V3Route[]) {
      expect(step(nav, r, "page", d)).toEqual({
        page: { page: "project", id: "p1" },
        peek: [r],
      });
    }
    expect(step(nav, { page: "agent", id: "ada" }, "page", d)).toEqual({
      page: { page: "agent", id: "ada" },
      peek: [],
    });
  });

  test("an agent row on People opens beside; a project link anywhere navigates", () => {
    expect(
      step(on({ page: "people" }), { page: "agent", id: "ada" }, "page", d),
    ).toEqual({
      page: { page: "people" },
      peek: [{ page: "agent", id: "ada" }],
    });
    expect(
      step(on({ page: "goals" }), { page: "project", id: "p1" }, "page", d),
    ).toEqual({
      page: { page: "project", id: "p1" },
      peek: [],
    });
  });
});

describe("links inside the peek extend its trail", () => {
  test("a peek link to an unrelated record stacks, Back walks back", () => {
    const nav = on({ page: "project", id: "p1" }, [
      { page: "thread", id: "t1" },
    ]);
    const next = step(nav, { page: "agent", id: "bea" }, "peek", d);
    expect(next).toEqual({
      page: { page: "project", id: "p1" },
      peek: [
        { page: "thread", id: "t1" },
        { page: "agent", id: "bea" },
      ],
    });
    // The peek's Back pops the trail — the page never moved.
    expect({ ...next, peek: next.peek.slice(0, -1) }).toEqual(nav);
  });

  test("opening something already on the trail goes back to it", () => {
    const nav = on({ page: "threads" }, [
      { page: "thread", id: "t1" },
      { page: "ticket", id: "LIL-1" },
    ]);
    expect(step(nav, { page: "thread", id: "t1" }, "peek", d)).toEqual({
      page: { page: "threads" },
      peek: [{ page: "thread", id: "t1" }],
    });
  });
});

describe("the codec keeps place in the URL", () => {
  test("a record page round-trips as page=<kind>&id=<id>", () => {
    const nav = on({ page: "project", id: "p1" });
    const q = paramsFromNav(nav);
    expect(q.get("page")).toBe("project");
    expect(q.get("id")).toBe("p1");
    // navFromParams always answers `full`, set or not.
    expect(navFromParams(q)).toEqual({ ...nav, full: false });
  });

  test("a record page plus its peek round-trips together", () => {
    const nav = on({ page: "project", id: "p1" }, [
      { page: "thread", id: "t1" },
      { page: "agent", id: "bea" },
    ]);
    expect(navFromParams(paramsFromNav(nav))).toEqual({
      ...nav,
      full: false,
    });
  });

  test("a page with view and a peeked record still parse as before", () => {
    const nav = navFromParams(
      new URLSearchParams("page=threads&view=all&open=thread:t1&full=1"),
    );
    expect(nav).toEqual({
      page: { page: "threads", view: "all" },
      peek: [{ page: "thread", id: "t1" }],
      full: true,
    });
  });
});
