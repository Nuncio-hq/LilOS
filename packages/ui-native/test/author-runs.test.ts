import { describe, expect, it } from "vitest";
import {
  agentKey,
  runStarts,
  turnAuthorLines,
} from "../src/v3/thread/author-runs";
import type { TurnVM } from "../src/v3/thread/types";

const a = { author: "a" };
const b = { author: "b" };
const me = { author: "you" };
const note = {};

describe("runStarts", () => {
  it("opens one run for consecutive messages by the same author", () => {
    expect(runStarts([a, a, a])).toEqual([true, false, false]);
  });

  it("starts a new run when the author changes", () => {
    expect(runStarts([a, b, b, a])).toEqual([true, true, false, true]);
  });

  it("starts a new run after the owner's bubble in between", () => {
    expect(runStarts([a, a, me, a, a])).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });

  it("lets a system note end the run without opening one", () => {
    expect(runStarts([a, note, a])).toEqual([true, false, true]);
    expect(runStarts([note, a, a])).toEqual([false, true, false]);
  });

  it("skips the line of a first run the header already names", () => {
    expect(runStarts([a, a, me, a], "a")).toEqual([false, false, true, true]);
    expect(runStarts([b, a], "a")).toEqual([true, true]);
  });

  it("is empty for no messages", () => {
    expect(runStarts([])).toEqual([]);
  });
});

const turn = (over: Partial<TurnVM>): TurnVM => ({
  key: "t",
  steps: [],
  live: false,
  streaming: false,
  attachments: [],
  queued: [],
  ...over,
});
const prompt = (fromYou: boolean, who = "Chief") => ({
  fromYou,
  who,
  at: "12:00",
  text: "x",
  files: [],
});

describe("turnAuthorLines", () => {
  it("draws one line for consecutive agent turns with no prompt between", () => {
    const turns = [
      turn({ answer: "one" }),
      turn({ answer: "two" }),
      turn({ answer: "three" }),
    ];
    expect(turnAuthorLines(turns, "ceo", false)).toEqual([true, false, false]);
  });

  it("starts a new run after the owner's message", () => {
    const turns = [
      turn({ answer: "one" }),
      turn({ answer: "two" }),
      turn({ prompt: prompt(true), answer: "reply" }),
    ];
    expect(turnAuthorLines(turns, "ceo", false)).toEqual([true, false, true]);
  });

  it("leaves the first run to the header when it names the agent", () => {
    const turns = [
      turn({ answer: "one" }),
      turn({ answer: "two" }),
      turn({ prompt: prompt(true), answer: "reply" }),
    ];
    expect(turnAuthorLines(turns, "ceo", true)).toEqual([false, false, true]);
  });

  it("treats someone else's question as a different author", () => {
    const turns = [
      turn({ prompt: prompt(false, "Chief"), answer: "one" }),
      turn({ prompt: prompt(false, "Chief"), answer: "two" }),
    ];
    expect(turnAuthorLines(turns, "builder", false)).toEqual([true, true]);
  });

  it("counts your queued message as breaking the run", () => {
    const turns = [
      turn({ answer: "one", queued: [{ key: "q", at: "12:01", text: "hm" }] }),
      turn({ answer: "two" }),
    ];
    expect(turnAuthorLines(turns, "ceo", false)).toEqual([true, true]);
  });

  it("counts a turn that only carries a plan as the agent's", () => {
    const plan = {
      status: "proposed" as const,
      version: 1,
      steps: [],
      risks: [],
    };
    const turns = [turn({ prompt: prompt(true) }), turn({ plan })];
    expect(turnAuthorLines(turns, "ceo", false)).toEqual([false, true]);
  });

  it("gives a prompt-only turn no line", () => {
    const turns = [turn({ prompt: prompt(true) })];
    expect(turnAuthorLines(turns, "ceo", false)).toEqual([false]);
  });

  it("keys the agent so two agents never share a run", () => {
    expect(agentKey("a")).not.toBe(agentKey("b"));
  });
});
