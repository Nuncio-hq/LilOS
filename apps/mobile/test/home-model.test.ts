import { DEVICE_CACHE_SCHEMA_VERSION } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  dmChannelFor,
  ensureChannelSubscriptions,
  type HomeWire,
  openAsks,
  toApproval,
  toEmployeeRow,
} from "../src/home-model";

/* Home's derivation from wire data (#155): employees/channels/conversations/
   asks as the relay serves them -> the EmployeeRow/Approval view models
   ui-native renders. NOW is frozen so age labels are deterministic. */

const NOW = 1_700_000_000_000;

const emp = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: `Emp ${id}`,
  role: "Engineer",
  status: "online",
  profile: "",
  model: "fake-large",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 1,
  ...over,
});

const ch = (id: string, employeeId: string): AppChannel => ({
  id,
  kind: "dm",
  employeeId,
  lastSeq: 1,
  createdAt: 1,
});

const conv = (
  id: string,
  channelId: string,
  over: Partial<Conversation> = {},
): Conversation => ({
  id,
  channelId,
  rootMessageId: `m-${id}`,
  engineRef: null,
  state: "idle",
  title: "",
  titleSource: "auto",
  access: "ask",
  deliveredSeq: 0,
  archived: false,
  createdAt: 1,
  ...over,
});

const msg = (
  id: string,
  channelId: string,
  conversationId: string | null,
  text: string,
): AppMessage => ({
  id,
  channelId,
  conversationId,
  authorId: "user",
  authorKind: "user",
  text,
  seq: 1,
  createdAt: 1,
  rewound: false,
  dropped: false,
  removed: false,
  claimed: false,
});

const sum = (
  conversation: Conversation,
  root: AppMessage,
): ConversationSummary => ({
  conversation,
  root,
  last: root,
  messageCount: 1,
});

const ask = (
  id: string,
  channelId: string,
  conversationId: string,
  createdAt: number,
  over: Partial<Ask> = {},
): Ask => ({
  id,
  channelId,
  conversationId,
  turnId: `t-${id}`,
  requestId: `r-${id}`,
  request: {
    kind: "approval",
    command: `patch ${id}`,
    description: `patch wants to run: patch ${id}`,
    options: ["once", "always", "deny"],
  },
  state: "open",
  createdAt,
  ...over,
});

const wire = (over: Partial<HomeWire> = {}): HomeWire => ({
  employees: [],
  channels: [],
  conversations: [],
  summaries: [],
  asks: [],
  online: true,
  ...over,
});

describe("home-model (#155)", () => {
  it("AC-1 an active conversation marks the employee working with its title as the now line", () => {
    const w = wire({
      channels: [ch("ch1", "e1")],
      conversations: [
        conv("c1", "ch1", { state: "active", title: "Fix the ac-80 flake" }),
      ],
    });
    const row = toEmployeeRow(emp("e1"), w, NOW);
    expect(row.state).toBe("working");
    expect(row.now).toBe("Fix the ac-80 flake");
    expect(row.when).toBe("now");

    // No title yet → the thread's root message stands in.
    const w2 = wire({
      channels: [ch("ch1", "e1")],
      conversations: [conv("c1", "ch1", { state: "active" })],
      summaries: [
        sum(
          conv("c1", "ch1", { state: "active" }),
          msg("m-c1", "ch1", "c1", "Summarize the relay package"),
        ),
      ],
    });
    expect(toEmployeeRow(emp("e1"), w2, NOW).now).toBe(
      "Summarize the relay package",
    );
  });

  it("AC-1 an idle employee falls back to its stored now line (or Idle/Offline)", () => {
    const w = wire({ channels: [ch("ch1", "e1")] });
    expect(
      toEmployeeRow(emp("e1", { now: "Reviewed #93" }), w, NOW),
    ).toMatchObject({ state: "idle", now: "Reviewed #93", when: "" });
    expect(toEmployeeRow(emp("e1"), w, NOW).now).toBe("Idle");
    expect(toEmployeeRow(emp("e1", { status: "offline" }), w, NOW).now).toBe(
      "Offline",
    );
    // Archived conversations never count as work.
    const archived = wire({
      channels: [ch("ch1", "e1")],
      conversations: [conv("c1", "ch1", { state: "active", archived: true })],
    });
    expect(toEmployeeRow(emp("e1"), archived, NOW).state).toBe("idle");
  });

  it("AC-2 openAsks is every open ask oldest first; empty means the accessory hides", () => {
    const asks = [
      ask("a2", "ch1", "c1", NOW - 60_000),
      ask("a1", "ch1", "c1", NOW - 120_000),
      ask("a3", "ch1", "c1", NOW - 30_000, { state: "resolved" }),
    ];
    expect(openAsks(asks).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(openAsks([])).toEqual([]);

    // One ask: the now line names what waits on you.
    const one = wire({
      channels: [ch("ch1", "e1")],
      conversations: [conv("c1", "ch1", { title: "Patch README" })],
      asks: [ask("a1", "ch1", "c1", NOW - 120_000)],
    });
    const row = toEmployeeRow(emp("e1"), one, NOW);
    expect(row.state).toBe("needs-you");
    expect(row.now).toBe("Waiting on you · Patch README");
    expect(row.when).toBe("2m");

    // Several open asks on the same employee collapse to a count.
    const two = wire({
      channels: [ch("ch1", "e1")],
      conversations: [
        conv("c1", "ch1", { title: "First" }),
        conv("c2", "ch1", { title: "Second" }),
      ],
      asks: [
        ask("a1", "ch1", "c1", NOW - 120_000),
        ask("a2", "ch1", "c2", NOW - 60_000),
      ],
    });
    expect(toEmployeeRow(emp("e1"), two, NOW).now).toBe("2 need you");
    expect(toEmployeeRow(emp("e1"), two, NOW).state).toBe("needs-you");
  });

  it("AC-3 toApproval maps an ask onto the Activity row — employee, session, command, age", () => {
    const w = wire({
      employees: [emp("e1"), emp("e2")],
      channels: [ch("ch1", "e1"), ch("ch2", "e2")],
      conversations: [
        conv("c1", "ch1", { title: "Patch README" }),
        conv("c2", "ch2", { title: "B" }),
      ],
      asks: [
        ask("newer", "ch2", "c2", NOW - 60_000),
        ask("older", "ch1", "c1", NOW - 120_000),
        ask("done", "ch1", "c1", NOW - 200_000, { state: "resolved" }),
      ],
    });
    const approvals = openAsks(w.asks).map((a) => toApproval(a, w, NOW));
    expect(approvals.map((a) => a.id)).toEqual(["older", "newer"]);
    expect(approvals[0]).toMatchObject({
      employeeId: "e1",
      employee: "Emp e1",
      session: "Patch README",
      command: "patch older",
      reason: "patch older",
      age: "2m",
    });
    expect(approvals[1]).toMatchObject({ employee: "Emp e2", age: "1m" });
  });

  it("AC-3 a question ask carries its question as the reason and no command", () => {
    const w = wire({
      employees: [emp("e1")],
      channels: [ch("ch1", "e1")],
      asks: [
        ask("q1", "ch1", "c1", NOW - 60_000, {
          request: { kind: "question", question: "Keep it or drop it?" },
        }),
      ],
    });
    const [row] = openAsks(w.asks).map((a) => toApproval(a, w, NOW));
    expect(row?.reason).toBe("Keep it or drop it?");
    expect(row?.command).toBeUndefined();
  });

  it("AC-4 the ask's DM channel resolves the employee a tap opens", () => {
    const w = wire({
      employees: [emp("e1")],
      channels: [ch("ch1", "e1"), ch("ch2", "e2")],
      asks: [ask("a1", "ch1", "c1", NOW - 60_000)],
    });
    expect(dmChannelFor(w.channels, "e1")?.id).toBe("ch1");
    expect(dmChannelFor(w.channels, "missing")).toBeUndefined();
    expect(toApproval(w.asks[0] as Ask, w, NOW).employeeId).toBe("e1");
  });

  it("AC-5 a hydrated directory snapshot derives rows before any live event", async () => {
    const { RelayClient } = await import("@lilos/client-runtime");
    const client = new RelayClient({
      url: "ws://test",
      token: "t",
      autoReconnect: false,
    });
    client.hydrate({
      schemaVersion: DEVICE_CACHE_SCHEMA_VERSION,
      savedAt: 1,
      employees: [emp("e1")],
      channels: [ch("ch1", "e1")],
      conversations: [
        conv("c1", "ch1", { state: "active", title: "Cached task" }),
      ],
      conversationSummaries: [],
      profile: {},
      asks: [],
      watermarks: {},
    });
    const w = wire({
      employees: client.employees.get(),
      channels: client.channels.get(),
      conversations: client.conversations.get(),
      summaries: client.conversationSummaries.get(),
      asks: client.asks.get(),
    });
    const rows = w.employees.map((e) => toEmployeeRow(e, w, NOW));
    expect(rows[0]).toMatchObject({
      name: "Emp e1",
      state: "working",
      now: "Cached task",
    });
  });

  it("AC-2 offline rows say last known: ask rows and live-looking now-lines (#591)", () => {
    const w = wire({
      online: false,
      employees: [emp("e1")],
      channels: [ch("ch1", "e1")],
      conversations: [
        conv("c1", "ch1", { title: "Patch README" }),
        conv("c2", "ch1", { state: "active", title: "Mid-turn task" }),
      ],
      asks: [ask("a1", "ch1", "c1", NOW - 120_000)],
    });
    // Activity's ask row is marked...
    expect(toApproval(w.asks[0] as Ask, w, NOW).lastKnown).toBe(true);
    // ...and so are the live-looking employee states.
    const row = toEmployeeRow(emp("e1"), w, NOW);
    expect(row.now).toBe("Last known · Waiting on you · Patch README");
    expect(row.lastKnown).toBe(true);
    // Online, the same wire carries no mark.
    const live = wire({ ...w, online: true });
    expect(toApproval(live.asks[0] as Ask, live, NOW).lastKnown).toBe(
      undefined,
    );
    expect(toEmployeeRow(emp("e1"), live, NOW).now).toBe(
      "Waiting on you · Patch README",
    );
  });

  it("AC-2 a working row offline reads last known; an idle row stays plain (#591)", () => {
    const w = wire({
      online: false,
      channels: [ch("ch1", "e1"), ch("ch2", "e2")],
      conversations: [
        conv("c1", "ch1", { state: "active", title: "Mid-turn task" }),
      ],
    });
    const e1 = toEmployeeRow(emp("e1"), w, NOW);
    expect(e1.now).toBe("Last known · Mid-turn task");
    expect(e1.lastKnown).toBe(true);
    const e2 = toEmployeeRow(emp("e2"), w, NOW);
    expect(e2.now).toBe("Idle");
    expect(e2.lastKnown).toBeUndefined();
  });

  it("AC-2 a long session label offline can never truncate the marker away (#591)", () => {
    const long = "x".repeat(200);
    const w = wire({
      online: false,
      channels: [ch("ch1", "e1")],
      conversations: [
        conv("c1", "ch1", { state: "active", title: `Refactor ${long}` }),
      ],
      asks: [ask("a1", "ch1", "c2", NOW - 60_000)],
    });
    /* The row renders `now` on one truncating line — the marker must be
       FIRST, so a label of any length still reads stale. */
    for (const row of [
      /* the ask path: "Waiting on you · <long label>" */
      toEmployeeRow(emp("e1"), w, NOW),
      /* the working path: "<long label>" */
      toEmployeeRow(emp("e1"), { ...w, asks: [] }, NOW),
    ]) {
      expect(row.now.startsWith("Last known · ")).toBe(true);
      expect(row.lastKnown).toBe(true);
    }
  });

  it("AC-1 every DM channel gets a subscription so asks and turns arrive live", () => {
    const subscribed: string[] = [];
    const client = {
      channelMessages: (channelId: string) => subscribed.push(channelId),
    };
    ensureChannelSubscriptions(client as never, [
      ch("ch1", "e1"),
      ch("ch2", "e2"),
    ]);
    expect(subscribed).toEqual(["ch1", "ch2"]);
  });
});
