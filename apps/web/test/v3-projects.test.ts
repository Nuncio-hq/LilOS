// @vitest-environment happy-dom
/* Projects in the real app's v3 data (D-#771): the relay's projects reach the
   sidebar and the project page with a stable colour, every thread carries the
   project it lives in (a plain chat has none), and the new chat starts where
   the agent's last chat did. */
import type { AppChannel, Conversation, Project } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { projectRows } from "../src/v3/data";
import { lastChats, type ThreadSources, v3Threads } from "../src/v3/threads";

const project = (over: Partial<Project>): Project => ({
  id: "p1",
  name: "LilOS",
  key: "LIL",
  folder: "/Users/me/lilos",
  about: "",
  createdAt: 1,
  ...over,
});

describe("the relay's projects as the pages read them", () => {
  test("keep the record and add a colour that depends only on the id", () => {
    const [a] = projectRows([project({})]);
    expect(a).toMatchObject({
      id: "p1",
      name: "LilOS",
      key: "LIL",
      folder: "/Users/me/lilos",
      about: "",
    });
    // The same project is the same colour on every screen and every boot.
    expect(projectRows([project({ name: "Renamed" })])[0].tone).toBe(a.tone);
  });

  test("come oldest first, so the sidebar only grows at its end", () => {
    const rows = projectRows([
      project({ id: "late", createdAt: 9 }),
      project({ id: "early", createdAt: 2 }),
    ]);
    expect(rows.map((p) => p.id)).toEqual(["early", "late"]);
  });
});

const channel: AppChannel = {
  id: "ch1",
  kind: "dm",
  employeeId: "emp1",
  lastSeq: 0,
  createdAt: 0,
};

const conv = (over: Partial<Conversation>): Conversation =>
  ({
    id: "c1",
    channelId: "ch1",
    rootMessageId: "m1",
    engineRef: null,
    state: "idle",
    title: "A thread",
    titleSource: "auto",
    access: "ask",
    archived: false,
    createdAt: 0,
    ...over,
  }) as Conversation;

const sources = (conversations: Conversation[]): ThreadSources => ({
  now: 10 * 60_000,
  conversations,
  summaries: [],
  channels: [channel],
  employees: [],
  models: {},
  signals: {},
  asks: [],
});

describe("a thread's project", () => {
  test("a thread in a project carries it; a plain chat carries none", () => {
    const rows = v3Threads(
      sources([
        conv({ id: "in", cwd: "/Users/me/lilos", projectId: "p1" }),
        conv({ id: "plain" }),
      ]),
    );
    const by = (id: string) => rows.find((t) => t.id === id);
    expect(by("in")?.projectId).toBe("p1");
    expect(by("in")?.folder).toBe("/Users/me/lilos");
    expect(by("plain")?.projectId).toBeUndefined();
    expect(by("plain")?.folder).toBeUndefined();
  });

  test("the new chat starts where the agent's newest chat lived", () => {
    const chats = (...cs: Conversation[]) => lastChats(sources(cs)).get("emp1");
    expect(
      chats(
        conv({ id: "old", createdAt: 1, projectId: "p1" }),
        conv({ id: "new", createdAt: 2, projectId: "p2" }),
      )?.projectId,
    ).toBe("p2");
    // A plain chat counts: "No project" is a choice that must stick.
    expect(
      chats(
        conv({ id: "old", createdAt: 1, projectId: "p1" }),
        conv({ id: "new", createdAt: 2 }),
      )?.projectId,
    ).toBeUndefined();
  });
});
