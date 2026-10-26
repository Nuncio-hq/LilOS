import type * as acp from "@agentclientprotocol/sdk";
import type { EngineEventType, Usage } from "@lilos/contracts/engine";
import { describe, expect, test } from "vitest";
import {
  type AcpSessionView,
  acpStopReason,
  acpTurnUsage,
  handleAcpUpdate,
  toAcpContent,
  toAcpMcp,
} from "../src/mapping.js";

/** Minimal AcpSessionView recorder — the shared map's write surface. */
const mkSession = () => {
  const events: { type: EngineEventType; payload: unknown }[] = [];
  const s: AcpSessionView & { events: typeof events } = {
    events,
    lastTurnId: "t0",
    usage: undefined,
    turn: { turnId: "t1", phase: "reasoning" },
    emit(type, payload) {
      events.push({ type, payload });
    },
  };
  return s;
};

const note = (update: Record<string, unknown>): acp.SessionNotification =>
  ({ sessionId: "acp-1", update }) as acp.SessionNotification;

describe("handleAcpUpdate — the shared update map (D-#764)", () => {
  test("agent_message_chunk emits a text turn.delta on the open turn", () => {
    const s = mkSession();
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    );
    expect(s.events).toEqual([
      {
        type: "turn.delta",
        payload: { turnId: "t1", stream: "text", delta: "hello" },
      },
    ]);
    expect(s.turn?.phase).toBe("text");
  });

  test("agent_thought_chunk rides the reasoning stream", () => {
    const s = mkSession();
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      }),
    );
    expect(s.events[0]).toEqual({
      type: "turn.delta",
      payload: { turnId: "t1", stream: "reasoning", delta: "thinking" },
    });
    expect(s.turn?.phase).toBe("reasoning");
  });

  test("a chunk with no open turn still lands on lastTurnId", () => {
    const s = mkSession();
    s.turn = undefined;
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late" },
      }),
    );
    expect(s.events[0]?.payload).toMatchObject({ turnId: "t0" });
  });

  test("tool_call -> tool.started; tool_call_update -> tool.completed", () => {
    const s = mkSession();
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit README.md",
        rawInput: { path: "README.md" },
      }),
    );
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        title: "Edit README.md",
        status: "completed",
        rawOutput: "ok",
      }),
    );
    expect(s.events[0]).toEqual({
      type: "tool.started",
      payload: {
        turnId: "t1",
        toolCallId: "c1",
        tool: "Edit README.md",
        input: { path: "README.md" },
      },
    });
    expect(s.events[1]).toMatchObject({
      type: "tool.completed",
      payload: { status: "completed", output: "ok" },
    });
    expect(s.turn?.phase).toBe("tools");
  });

  test("non-terminal tool_call_update statuses emit nothing", () => {
    const s = mkSession();
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
      }),
    );
    expect(s.events).toEqual([]);
  });

  test("plan snapshots version in place on the turn's stable planId", () => {
    const s = mkSession();
    const plan = {
      sessionUpdate: "plan",
      entries: [
        { content: "read", status: "completed" },
        { content: "edit", status: "in_progress" },
      ],
    };
    handleAcpUpdate(s, note(plan));
    handleAcpUpdate(s, note(plan));
    expect(s.events).toEqual([
      {
        type: "plan.updated",
        payload: {
          turnId: "t1",
          planId: "plan-t1",
          kind: "tasks",
          version: 1,
          steps: [
            { text: "read", status: "completed" },
            { text: "edit", status: "in_progress" },
          ],
        },
      },
      {
        type: "plan.updated",
        payload: {
          turnId: "t1",
          planId: "plan-t1",
          kind: "tasks",
          version: 2,
          steps: [
            { text: "read", status: "completed" },
            { text: "edit", status: "in_progress" },
          ],
        },
      },
    ]);
  });

  test("plan updates without an open turn drop (AC-6)", () => {
    const s = mkSession();
    s.turn = undefined;
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "plan", entries: [{ content: "x" }] }),
    );
    expect(s.events).toEqual([]);
  });

  test("usage_update lands on context/contextWindow, malformed values drop", () => {
    const s = mkSession();
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "usage_update", used: 4096, size: 200_000 }),
    );
    expect(s.usage).toMatchObject({ context: 4096, contextWindow: 200_000 });
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "usage_update", used: "junk", size: -1 }),
    );
    expect(s.usage).toMatchObject({ context: 4096, contextWindow: 200_000 });
  });

  test("lifecycle kinds route to hooks; unknown kinds drop silently", () => {
    const s = mkSession();
    const seen: string[] = [];
    const hooks = {
      onModeUpdate: (_s: AcpSessionView, id: string) => seen.push(`mode:${id}`),
      onCommandsUpdate: (_s: AcpSessionView, c: unknown[]) =>
        seen.push(`commands:${c.length}`),
      onNotice: () => seen.push("notice"),
      onCompaction: () => seen.push("compact"),
    };
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "current_mode_update", currentModeId: "ask" }),
      hooks,
    );
    handleAcpUpdate(
      s,
      note({
        sessionUpdate: "available_commands_update",
        availableCommands: [{}, {}],
      }),
      hooks,
    );
    handleAcpUpdate(s, note({ sessionUpdate: "notice", text: "hi" }), hooks);
    handleAcpUpdate(s, note({ sessionUpdate: "compaction_update" }), hooks);
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "brand_new_kind_from_v9" }),
      hooks,
    );
    handleAcpUpdate(
      s,
      note({ sessionUpdate: "user_message_chunk", content: { text: "x" } }),
      hooks,
    );
    expect(seen).toEqual(["mode:ask", "commands:2", "notice", "compact"]);
    expect(s.events).toEqual([]);
  });
});

describe("content / mcp / stopReason / usage mapping", () => {
  test("toAcpContent maps the engine union (text + image)", () => {
    expect(toAcpContent({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
    expect(
      toAcpContent({ type: "image", data: "AA==", mimeType: "image/png" }),
    ).toEqual({ type: "image", data: "AA==", mimeType: "image/png" });
  });

  test("toAcpMcp maps stdio and remote server shapes", () => {
    expect(
      toAcpMcp({ name: "x", command: "c", args: ["a"], env: [] }),
    ).toMatchObject({ name: "x", command: "c", args: ["a"] });
    expect(
      toAcpMcp({ type: "http", name: "x", url: "http://h", headers: [] }),
    ).toMatchObject({ type: "http", url: "http://h" });
  });

  test("acpStopReason passes known reasons and degrades unknowns", () => {
    for (const r of [
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ])
      expect(acpStopReason(r)).toBe(r);
    expect(acpStopReason("something_else")).toBe("end_turn");
    expect(acpStopReason(undefined)).toBe("end_turn");
  });

  test("acpTurnUsage folds per-turn counts into lifetime sums (#415)", () => {
    const prev: Usage = {
      input: 10,
      output: 5,
      reasoning: 1,
      cache: 0,
      context: 100,
      contextWindow: 200_000,
    };
    const next = acpTurnUsage(prev, {
      inputTokens: 50,
      outputTokens: 25,
      thoughtTokens: 10,
      cachedReadTokens: 4,
    });
    expect(next).toEqual({
      input: 60,
      output: 30,
      reasoning: 11,
      cache: 4,
      context: 100,
      contextWindow: 200_000,
    });
    expect(acpTurnUsage(prev, undefined)).toBe(prev);
    expect(acpTurnUsage(undefined, null)).toBeUndefined();
  });
});
