import { RPC_ERRORS, type EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import {
  ManualClock,
  recoverInFlight,
  recoverTurn,
  watchWake,
} from "../src/index.js";
import { rpcError, stubEngine } from "./fakes.js";

const ev = (seq: number, type: string, payload: unknown): EngineEvent =>
  ({ seq, sessionId: "s1", type, payload }) as EngineEvent;

describe("recoverTurn (AC-4)", () => {
  const watched = { sessionId: "s1", turnId: "t7", lastSeq: 5 };

  it("AC-4 turn still running after wake → resumed with the missed events", async () => {
    const conn = stubEngine(() => ({
      events: [ev(6, "turn.delta", { turnId: "t7", stream: "text", delta: "hi" })],
      latestSeq: 6,
      truncated: false,
      openRequests: [],
      snapshot: {
        sessionId: "s1",
        state: "running",
        turn: { turnId: "t7", phase: "text" },
      },
    }));
    const v = await recoverTurn(conn, watched);
    expect(v.kind).toBe("resumed");
    expect(conn.calls[0]).toEqual({
      method: "events.since",
      params: { sessionId: "s1", after: 5 },
    });
  });

  it("AC-4 turn completed during the gap → completed, stop reason replayed", async () => {
    const conn = stubEngine(() => ({
      events: [
        ev(6, "turn.completed", { turnId: "t7", stopReason: "end_turn" }),
      ],
      latestSeq: 7,
      truncated: false,
      openRequests: [],
      snapshot: { sessionId: "s1", state: "idle" },
    }));
    const v = await recoverTurn(conn, watched);
    expect(v).toMatchObject({
      kind: "completed",
      turnId: "t7",
      stopReason: "end_turn",
    });
  });

  it("AC-4 session unknown to the engine after wake → interrupted + retry, never a spinner", async () => {
    const conn = stubEngine(() => {
      throw rpcError(RPC_ERRORS.SESSION_NOT_FOUND, "no session s1");
    });
    const v = await recoverTurn(conn, watched);
    expect(v).toEqual({
      kind: "interrupted",
      sessionId: "s1",
      turnId: "t7",
      reason: "session_lost",
      retry: true,
    });
  });

  it("AC-4 replay truncated and the turn is gone → interrupted (outcome unknown)", async () => {
    const conn = stubEngine(() => ({
      events: [],
      latestSeq: 40,
      truncated: true,
      openRequests: [],
      snapshot: { sessionId: "s1", state: "idle" },
    }));
    const v = await recoverTurn(conn, watched);
    expect(v).toMatchObject({
      kind: "interrupted",
      reason: "replay_truncated",
      retry: true,
    });
  });

  it("AC-4 session alive but the turn vanished silently → interrupted", async () => {
    // Engine restarted with a store that kept the session but dropped the
    // in-flight turn (SP2 leg A: reaped while orphaned).
    const conn = stubEngine(() => ({
      events: [],
      latestSeq: 5,
      truncated: false,
      openRequests: [],
      snapshot: { sessionId: "s1", state: "idle" },
    }));
    const v = await recoverTurn(conn, watched);
    expect(v).toMatchObject({
      kind: "interrupted",
      reason: "turn_lost",
      retry: true,
    });
  });
});

describe("recoverInFlight (AC-4/AC-5)", () => {
  it("AC-4 every watched turn gets a verdict within the orphan grace", async () => {
    const conn = stubEngine((method, params) => ({
      events: [
        ev(9, "turn.completed", {
          turnId: (params as { sessionId: string }).sessionId,
          stopReason: "end_turn",
        }),
      ],
      latestSeq: 9,
      truncated: false,
      openRequests: [],
      snapshot: {
        sessionId: (params as { sessionId: string }).sessionId,
        state: "idle",
      },
    }));
    const watched = [
      { sessionId: "a", turnId: "a", lastSeq: 0 },
      { sessionId: "b", turnId: "b", lastSeq: 2 },
    ];
    const res = await recoverInFlight(conn, watched, { orphanGraceMs: 20_000 });
    expect(res.verdicts).toHaveLength(2);
    expect(res.verdicts.every((v) => v.kind === "completed")).toBe(true);
    expect(res.withinGrace).toBe(true);
  });
});

describe("wake detector (AC-3/AC-4 signal)", () => {
  it("a heartbeat tick landing after a wall-clock jump reports a wake", () => {
    const clock = new ManualClock();
    let wall = 0;
    const wakes: number[] = [];
    const det = watchWake({
      clock,
      wall: () => wall,
      intervalMs: 5_000,
      driftMs: 10_000,
      onWake: (gap) => wakes.push(gap),
    });
    wall += 5_000;
    clock.advance(5_000); // tick on schedule → no wake
    wall += 60_000; // process frozen: wall jumps, no tick ran
    clock.advance(5_000); // thaw: the overdue tick fires, sees the 60s gap
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toBe(60_000);
    det.stop();
  });

  it("ticks on schedule are not wakes", () => {
    const clock = new ManualClock();
    let wall = 0;
    const wakes: number[] = [];
    const det = watchWake({
      clock,
      wall: () => wall,
      intervalMs: 5_000,
      driftMs: 10_000,
      onWake: (gap) => wakes.push(gap),
    });
    for (let i = 0; i < 3; i++) {
      wall += 5_000;
      clock.advance(5_000);
    }
    expect(wakes).toHaveLength(0);
    det.stop();
  });
});
