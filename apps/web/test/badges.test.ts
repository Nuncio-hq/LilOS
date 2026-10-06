/**
 * Issue #32 — AC-3: the per-employee sidebar badge counts open approvals
 * (shown first, amber) and running turns (blue) for that employee's DM
 * conversations, driven by the live engine session models.
 */

import type { SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import { atom } from "nanostores";
import { describe, expect, it } from "vitest";
import { badgeStore, employeeBadges } from "../src/lib/badges";
import type { SessionSignal } from "../src/lib/session-watch";

const dm = (id: string, employeeId: string): AppChannel => ({
  id,
  kind: "dm",
  employeeId,
  lastSeq: 0,
  createdAt: 0,
});

/* #572: the row's `state` is now a badge source for unwatched sessions —
   the factory defaults to "idle"; mark "active" explicitly where the test
   means a running session. */
const conv = (
  id: string,
  channelId: string,
  engineRef: string | null,
): Conversation => ({
  id,
  channelId,
  rootMessageId: `m-${id}`,
  engineRef,
  state: "idle",
  title: "",
  titleSource: "user",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: 0,
});

const model = (opts: {
  live?: boolean;
  openRequests?: number;
  phase?: SessionModel["live"] extends infer T
    ? T extends { phase: infer P }
      ? P
      : never
    : never;
}): SessionModel => ({
  sessionId: "s",
  state: opts.live ? "running" : "idle",
  turns: [],
  jobs: [],
  live: opts.live
    ? {
        turnId: "t",
        phase: opts.phase ?? "reasoning",
        reasoning: "",
        text: "",
        steps: [],
        steers: [],
        plans: [],
        requests: [],
        subagents: [],
      }
    : undefined,
  openRequests: Array.from({ length: opts.openRequests ?? 0 }, (_, i) => ({
    requestId: `r${i}`,
    turnId: "t",
    request: { kind: "approval", command: "x", options: ["once"] },
  })),
});

describe("AC-3 employeeBadges", () => {
  it("counts running turns per employee", () => {
    const ch1 = dm("ch1", "e1");
    const ch2 = dm("ch2", "e2");
    const badges = employeeBadges(
      [ch1, ch2],
      [
        conv("c1", "ch1", "s1"),
        conv("c2", "ch1", "s2"),
        conv("c3", "ch2", "s3"),
      ],
      {
        s1: model({ live: true }),
        s2: model({ live: true }),
        s3: model({ live: false }),
      },
      {},
    );
    expect(badges).toEqual({ e1: { running: 2, approvals: undefined } });
  });

  it("counts open approvals (the waiting count) per employee", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1")],
      { s1: model({ live: true, openRequests: 2 }) },
      {},
    );
    expect(badges.e1).toEqual({ running: 1, approvals: 2 });
  });

  it("AC-4 (#71): a waiting turn is `needs you`, not `running`", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1")],
      { s1: model({ live: true, phase: "waiting", openRequests: 1 }) },
      {},
    );
    expect(badges.e1).toEqual({ running: undefined, approvals: 1 });
  });

  it("sums across the employee's conversations and skips unbound/unknown sessions", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges(
      [ch1],
      [
        conv("c1", "ch1", "s1"),
        conv("c2", "ch1", "s-missing"),
        conv("c3", "ch1", null),
      ],
      { s1: model({ openRequests: 1 }) },
      {},
    );
    expect(badges.e1).toEqual({ running: undefined, approvals: 1 });
  });

  it("no badge when nothing is running or waiting", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1")],
      { s1: model({}) },
      {},
    );
    expect(badges.e1).toBeUndefined();
  });
});

/* #572 AC-2: an unwatched session has no replayed model — the badge map
   falls back to the broadcast-folded signal, then the relay row. */
describe("AC-572 badges off signals for unwatched sessions", () => {
  const ch1 = dm("ch1", "e1");
  const signal = (over: Partial<SessionSignal> = {}): SessionSignal => ({
    running: false,
    openRequests: new Map(),
    ...over,
  });

  it("a signal-flagged running session badges without any model", () => {
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1"), conv("c2", "ch1", "s2")],
      {},
      { s2: signal({ running: true }) },
    );
    expect(badges.e1).toEqual({ running: 1, approvals: undefined });
  });

  it("a signal open-request counts as an approval, not running", () => {
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1")],
      {},
      {
        s1: signal({
          running: true,
          openRequests: new Map([
            ["r1", { kind: "approval", command: "x", options: ["once"] }],
          ]),
        }),
      },
    );
    expect(badges.e1).toEqual({ running: undefined, approvals: 1 });
  });

  it("no signal at all falls back to the conversation row's state", () => {
    const badges = employeeBadges(
      [ch1],
      [
        { ...conv("c1", "ch1", "s1"), state: "active" },
        conv("c2", "ch1", "s2"),
      ],
      {},
      {},
    );
    expect(badges.e1).toEqual({ running: 1, approvals: undefined });
  });

  it("a synced model wins over both signal and row", () => {
    const badges = employeeBadges(
      [ch1],
      [conv("c1", "ch1", "s1")],
      { s1: model({ live: true }) },
      { s1: signal({ running: false }) },
    );
    expect(badges.e1).toEqual({ running: 1, approvals: undefined });
  });
});

/* #427: the computed store keeps one record while the counts are equal —
   a `sessionModels` rebuild per streamed word must not fan out a sidebar
   re-render. */
describe("AC-427 badgeStore", () => {
  const setup = () => {
    const channels = atom<AppChannel[]>([dm("ch1", "e1")]);
    const convs = atom<Conversation[]>([conv("c1", "ch1", "s1")]);
    const models = atom<Record<string, SessionModel>>({
      s1: model({ live: true }),
    });
    return {
      channels,
      convs,
      models,
      store: badgeStore(channels, convs, models, atom({})),
    };
  };

  it("returns the same record when sources change but counts do not", () => {
    const { models, store } = setup();
    const a = store.get();
    expect(a.e1).toEqual({ running: 1, approvals: undefined });
    /* A delta rebuilds the session's model — same badge counts. */
    models.set({ s1: model({ live: true }) });
    expect(store.get()).toBe(a);
  });

  it("emits a new record only when a badge value moves", () => {
    const { models, store } = setup();
    const a = store.get();
    models.set({ s1: model({ live: true, openRequests: 2 }) });
    const b = store.get();
    expect(b).not.toBe(a);
    expect(b.e1).toEqual({ running: 1, approvals: 2 });
    /* Count back down → another record; equal counts in between stay put. */
    models.set({ s1: model({ live: true }) });
    const c = store.get();
    expect(c).not.toBe(b);
    models.set({ s1: model({ live: true }) });
    expect(store.get()).toBe(c);
  });

  it("empties to a fresh record when the last badge clears", () => {
    const { models, store } = setup();
    const a = store.get();
    models.set({});
    const b = store.get();
    expect(b).not.toBe(a);
    expect(b).toEqual({});
  });
});
