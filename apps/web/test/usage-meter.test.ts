/** #300: the context meter's usage pick — the live session model's newest
    turn wins; a dead/unreachable engine session (legacy `s<N>` engineRefs,
    restarted engines) still carries the last persisted turn.completed on the
    conversation row, so the meter + ring render off `conv.usage`. */
import type { SessionModel } from "@lilos/client-runtime";
import type { Conversation } from "@lilos/contracts/app";
import type { Usage } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { threadUsage } from "../src/lib/mapping";

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  channelId: "ch-dm",
  rootMessageId: "m0",
  engineRef: "s1",
  state: "idle",
  title: "legacy thread",
  titleSource: "auto",
  archived: false,
  deliveredSeq: 1,
  createdAt: 0,
  ...over,
});

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 12000,
  output: 3400,
  reasoning: 0,
  cache: 5000,
  contextWindow: 200000,
  ...over,
});

describe("threadUsage — the meter's usage pick (#300)", () => {
  it("falls back to the persisted conversation usage when the engine session is gone", () => {
    /* No replayed turns (dead `s1` degrades to an empty feed): the relay's
       persisted last turn.completed is all the meter needs. */
    const persisted = usage();
    expect(threadUsage(undefined, conv({ usage: persisted }))).toEqual(
      persisted,
    );
    const model = {
      sessionId: "s1",
      state: "closed",
      turns: [],
    } as unknown as SessionModel;
    expect(threadUsage(model, conv({ usage: persisted }))).toEqual(persisted);
  });

  it("a live turn's usage wins over the persisted row", () => {
    const live = usage({ input: 99000 });
    const model = {
      sessionId: "sess-live",
      state: "idle",
      turns: [
        { turnId: "t1", usage: usage({ input: 50000 }) },
        { turnId: "t2", usage: live },
      ],
    } as unknown as SessionModel;
    expect(threadUsage(model, conv({ usage: usage() }))).toEqual(live);
  });

  it("no usage anywhere means no meter", () => {
    expect(threadUsage(undefined, conv())).toBeUndefined();
  });
});
