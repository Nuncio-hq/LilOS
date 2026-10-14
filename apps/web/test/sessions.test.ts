import type { SessionModel } from "@lilos/client-runtime";
import type {
  AppChannel,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import type { EngineRequest } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { employeeBadges } from "../src/lib/badges";
import { sessionRows } from "../src/lib/sessions";

const conv = (over: Partial<Conversation>): Conversation =>
  ({
    id: "c1",
    channelId: "ch-a",
    rootMessageId: "m1",
    engineRef: "s1",
    state: "closed",
    title: "",
    access: "workspace",
    archived: false,
    life: "closed",
    readSeq: 0,
    finishedSeq: 0,
    deliveredSeq: 0,
    createdAt: 1,
    ...over,
  }) as Conversation;

const summary = (c: Conversation, last = 100): ConversationSummary =>
  ({
    conversation: c,
    root: { text: "the prompt" } as ConversationSummary["root"],
    last: { createdAt: last } as ConversationSummary["last"],
    messageCount: 2,
  }) as ConversationSummary;

const CHANNELS = [
  { id: "ch-a", kind: "dm", employeeId: "e-a" },
  { id: "ch-b", kind: "dm", employeeId: "e-b" },
  { id: "ch-c", kind: "dm", employeeId: "e-c" },
] as AppChannel[];
const EMPLOYEES = [
  { id: "e-a", name: "Ada" },
  { id: "e-b", name: "Bo" },
  { id: "e-c", name: "Cy" },
] as Employee[];
const fmt = () => "now";

const rowsOf = (
  summaries: ConversationSummary[],
  models: Record<string, SessionModel> = {},
  signals = {},
) =>
  sessionRows({
    summaries,
    channels: CHANNELS,
    employees: EMPLOYEES,
    models,
    signals,
    formatTime: fmt,
  });

describe("sessionRows", () => {
  it("groups needs-you / running / finished across employees", () => {
    const asking = conv({
      id: "c-ask",
      channelId: "ch-a",
      engineRef: "s-ask",
      state: "active",
    });
    const running = conv({
      id: "c-run",
      channelId: "ch-b",
      engineRef: "s-run",
      state: "active",
    });
    const done = conv({
      id: "c-done",
      channelId: "ch-c",
      engineRef: "s-done",
      state: "closed",
    });
    const groups = rowsOf(
      [summary(asking, 10), summary(running, 20), summary(done, 30)],
      {},
      {
        "s-ask": {
          running: true,
          openRequests: new Map([
            [
              "r1",
              {
                kind: "approval",
                command: "rm -rf build",
                options: ["once", "deny"],
              } satisfies EngineRequest,
            ],
          ]),
        },
        "s-run": { running: true, openRequests: new Map() },
      },
    );
    expect(groups.needsYou.map((r) => r.id)).toEqual(["c-ask"]);
    expect(groups.running.map((r) => r.id)).toEqual(["c-run"]);
    expect(groups.finished.map((r) => r.id)).toEqual(["c-done"]);
    expect(groups.needsYou[0].live).toBe("Approve: rm -rf build");
    expect(groups.needsYou[0].employeeName).toBe("Ada");
  });

  it("hides archived sessions", () => {
    const groups = rowsOf([summary(conv({ archived: true }))]);
    expect(groups.finished).toEqual([]);
  });

  it("reads unread off the watermark and lists unread finished first", () => {
    const unread = conv({
      id: "c-new",
      channelId: "ch-a",
      readSeq: 1,
      finishedSeq: 5,
    });
    const read = conv({
      id: "c-old",
      channelId: "ch-b",
      readSeq: 9,
      finishedSeq: 5,
    });
    /* `read` has the newer activity but the unread row still leads. */
    const groups = rowsOf([summary(unread, 10), summary(read, 99)]);
    expect(groups.finished.map((r) => r.id)).toEqual(["c-new", "c-old"]);
    expect(groups.finished[0].unread).toBe(true);
    expect(groups.finished[1].unread).toBe(false);
  });

  it("marks failed/stopped from the conversation flags", () => {
    const failed = conv({
      id: "c-f",
      channelId: "ch-a",
      turnFailure: { kind: "generic", text: "boom" },
    });
    const stopped = conv({ id: "c-s", channelId: "ch-b", turnStopped: true });
    const groups = rowsOf([summary(failed), summary(stopped)]);
    expect(groups.finished.map((r) => `${r.id}:${r.state}`)).toEqual([
      "c-f:failed",
      "c-s:stopped",
    ]);
  });

  it("shows the live tool step on a running row from its model", () => {
    const c = conv({
      id: "c-r",
      channelId: "ch-a",
      engineRef: "s-r",
      state: "active",
    });
    const model = {
      sessionId: "s-r",
      live: {
        phase: "tools",
        steps: [
          {
            id: "1",
            tool: "read_file",
            input: { path: "src/a.ts" },
            status: "completed",
          },
          {
            id: "2",
            tool: "write_file",
            input: { path: "src/b.ts" },
            status: "running",
          },
        ],
      },
      openRequests: [],
      turns: [],
    } as unknown as SessionModel;
    const groups = rowsOf([summary(c)], { "s-r": model });
    expect(groups.running[0].live).toBe("write_file src/b.ts");
  });

  it("group counts agree with the per-employee badges", () => {
    const convs = [
      conv({ id: "c1", channelId: "ch-a", engineRef: "s1", state: "active" }),
      conv({ id: "c2", channelId: "ch-a", engineRef: "s2", state: "active" }),
      conv({ id: "c3", channelId: "ch-b", engineRef: "s3", state: "closed" }),
    ];
    const signals = {
      s1: {
        running: true,
        openRequests: new Map<string, EngineRequest>([
          [
            "r",
            {
              kind: "approval",
              command: "bun test",
              options: ["once", "deny"],
            },
          ],
        ]),
      },
      s2: { running: true, openRequests: new Map<string, EngineRequest>() },
    };
    const groups = rowsOf(
      convs.map((c) => summary(c)),
      {},
      signals,
    );
    const badges = employeeBadges(CHANNELS, convs, {}, signals);
    expect(groups.needsYou.length).toBe(badges["e-a"].approvals);
    expect(groups.running.length).toBe(badges["e-a"].running);
  });
});
