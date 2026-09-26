/**
 * Issue #32 — AC-3: the per-employee sidebar badge counts open approvals
 * (shown first, amber) and running turns (blue) for that employee's DM
 * conversations, driven by the live engine session models.
 */

import type { SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { employeeBadges } from "../src/lib/badges";

const dm = (id: string, employeeId: string): AppChannel => ({
  id,
  kind: "dm",
  employeeId,
  lastSeq: 0,
  createdAt: 0,
});

const conv = (
  id: string,
  channelId: string,
  engineRef: string | null,
): Conversation => ({
  id,
  channelId,
  rootMessageId: `m-${id}`,
  engineRef,
  state: "active",
  title: "",
  archived: false,
  createdAt: 0,
});

const model = (opts: {
  live?: boolean;
  openRequests?: number;
}): SessionModel => ({
  sessionId: "s",
  state: opts.live ? "running" : "idle",
  turns: [],
  live: opts.live
    ? {
        turnId: "t",
        phase: "reasoning",
        reasoning: "",
        text: "",
        steps: [],
        steers: [],
        requests: [],
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
    );
    expect(badges).toEqual({ e1: { running: 2, approvals: undefined } });
  });

  it("counts open approvals (the waiting count) per employee", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges([ch1], [conv("c1", "ch1", "s1")], {
      s1: model({ live: true, openRequests: 2 }),
    });
    expect(badges.e1).toEqual({ running: 1, approvals: 2 });
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
    );
    expect(badges.e1).toEqual({ running: undefined, approvals: 1 });
  });

  it("no badge when nothing is running or waiting", () => {
    const ch1 = dm("ch1", "e1");
    const badges = employeeBadges([ch1], [conv("c1", "ch1", "s1")], {
      s1: model({}),
    });
    expect(badges.e1).toBeUndefined();
  });
});
