import type * as acp from "@agentclientprotocol/sdk";
import type { ApprovalOutcome, EngineRequest } from "@lilos/contracts/engine";
import { describe, expect, test } from "vitest";
import { AcpDriver } from "../src/acp.js";
import { HermesEngine } from "../src/engine.js";
import { resolveOutcomeValid, Session } from "../src/session.js";
import { FakeGateway } from "./fake-gateway.js";

/**
 * Issue #133 — ACP permission mapping. `hermes acp` offers two options of
 * kind `allow_always` (a session-scoped `allow_session` first, then the
 * permanent `allow_always`); picking by kind alone silently downgraded a
 * user's "Always" to "Allow for session" and the grant died with the
 * session. These tests drive the real `onPermission` handler with the real
 * option lists Hermes' adapter builds.
 */
describe("engine-hermes ACP permission mapping (#133)", () => {
  /**
   * Verbatim mirror of `acp_adapter/permissions.py::_build_permission_options`
   * (Hermes Agent source — the actual lists `hermes acp` sends on the wire).
   */
  const opt = (optionId: string, kind: string, name: string) => ({
    optionId,
    kind,
    name,
  });
  /** allow_permanent=True, allow_session=True — the common dangerous-command card. */
  const HERMES_FULL = [
    opt("allow_once", "allow_once", "Allow once"),
    opt("allow_session", "allow_always", "Allow for session"),
    opt("allow_always", "allow_always", "Allow always"),
    opt("deny", "reject_once", "Deny"),
    opt("deny_always", "reject_always", "Deny always"),
  ];
  /** allow_permanent=False — Hermes withholds "Allow always" entirely. */
  const HERMES_NO_PERMANENT = HERMES_FULL.filter(
    (o) => o.optionId !== "allow_always",
  );
  /** smart_denied / allow_session=False — the once-only collapse. */
  const HERMES_ONCE_ONLY = [
    opt("allow_once", "allow_once", "Allow once"),
    opt("deny", "reject_once", "Deny"),
  ];

  interface Rig {
    respond: (o: ApprovalOutcome) => void;
    ask: () => { request: EngineRequest };
    permission: (
      options: { optionId: string; kind: string; name: string }[],
    ) => Promise<acp.RequestPermissionResponse>;
  }

  /* #180: the EngineRequest union gained `plan`; these tests only ever ask
     approval requests, so narrow once instead of asserting at each site. */
  const approvalRequest = (request: EngineRequest) => {
    if (request.kind !== "approval")
      throw new Error(`expected approval, got ${request.kind}`);
    return request;
  };

  const rig = (): Rig => {
    let openRequest: EngineRequest | undefined;
    let settle: (v: { outcome: ApprovalOutcome }) => void = () => {};
    const engine = {
      openAsk: (
        _s: Session,
        _wireId: string,
        request: EngineRequest,
        _kind: "approval" | "clarify",
        _respond: (o: ApprovalOutcome) => void,
      ) => {
        openRequest = request;
        return new Promise<{ outcome: ApprovalOutcome; answer?: string }>(
          (r) => {
            settle = r;
          },
        );
      },
    } as unknown as HermesEngine;
    const driver = new AcpDriver({ bin: "hermes" }, engine);
    const session = new Session(
      "s1",
      "builder",
      "/tmp",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "acp",
      "rs1",
      "rs1",
      () => {},
    );
    const handler = driver as unknown as {
      onPermission(
        s: Session,
        p: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse>;
    };
    return {
      respond: (o) => settle({ outcome: o }),
      ask: () => {
        if (!openRequest) throw new Error("no request was opened");
        return { request: openRequest };
      },
      permission: (options) =>
        handler.onPermission(session, {
          sessionId: "rs1",
          toolCall: {
            toolCallId: "perm-check-1",
            title: "chmod 777 README.md",
          },
          options,
        } as acp.RequestPermissionRequest),
    };
  };

  const selected = (r: acp.RequestPermissionResponse) => {
    if (r.outcome.outcome !== "selected")
      throw new Error(`expected selected, got ${JSON.stringify(r.outcome)}`);
    return r.outcome.optionId;
  };

  test("AC-1 always -> allow_always, once -> allow_once (never the session-scope option)", async () => {
    const r = rig();
    const pending = r.permission(HERMES_FULL);
    // #106: the session grant is a real protocol outcome — `allow_session`
    // offers "session" by optionId (its kind alone would still misread).
    expect(approvalRequest(r.ask().request).options).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ]);
    r.respond("always");
    expect(selected(await pending)).toBe("allow_always");

    const r2 = rig();
    const pending2 = r2.permission(HERMES_FULL);
    r2.respond("once");
    expect(selected(await pending2)).toBe("allow_once");
  });

  test("#106 AC-4 'session' answers the session-scope option id", async () => {
    const r = rig();
    const pending = r.permission(HERMES_FULL);
    r.respond("session");
    expect(selected(await pending)).toBe("allow_session");
  });

  test("AC-2 deny prefers the plain `deny` id over deny_always", async () => {
    const r = rig();
    const pending = r.permission(HERMES_FULL);
    r.respond("deny");
    expect(selected(await pending)).toBe("deny");
  });

  test("AC-2 'always' is not offered when Hermes withholds allow_always (no silent downgrade)", async () => {
    const r = rig();
    const pending = r.permission(HERMES_NO_PERMANENT);
    const request = approvalRequest(r.ask().request);
    /* The session grant is still offerable — Hermes withholds the
       PERMANENT allow only. */
    expect(request.options).toEqual(["once", "session", "deny"]);
    // A client that answers "always" anyway is rejected, not downgraded.
    expect(
      resolveOutcomeValid(
        { request } as Parameters<typeof resolveOutcomeValid>[0],
        "always",
      ),
    ).toMatch(/not in offered options/);
    r.respond("deny");
    expect(selected(await pending)).toBe("deny");
  });

  test("AC-2 once-only lists (smart_denied) offer exactly once + deny", async () => {
    const r = rig();
    const pending = r.permission(HERMES_ONCE_ONLY);
    expect(approvalRequest(r.ask().request).options).toEqual(["once", "deny"]);
    r.respond("once");
    expect(selected(await pending)).toBe("allow_once");
  });

  test("AC-2 unknown optionId falls back to kind", async () => {
    const r = rig();
    const pending = r.permission([
      opt("permit_once", "allow_once", "Permit once"),
      opt("permit_forever", "allow_always", "Permit forever"),
      opt("nope", "reject_once", "Nope"),
    ]);
    expect(approvalRequest(r.ask().request).options).toEqual([
      "once",
      "always",
      "deny",
    ]);
    r.respond("always");
    expect(selected(await pending)).toBe("permit_forever");
  });

  test("AC-2 a kind lie on a known id never upgrades the grant", async () => {
    const r = rig();
    // allow_session claims kind allow_always; even alone it is session-scope
    // and must never answer an "always" outcome.
    const pending = r.permission([
      opt("allow_once", "allow_once", "Allow once"),
      opt("allow_session", "allow_always", "Allow for session"),
      opt("deny", "reject_once", "Deny"),
    ]);
    expect(approvalRequest(r.ask().request).options).toEqual([
      "once",
      "session",
      "deny",
    ]);
    r.respond("always"); // invalid for the offered set; the pick must not land on it
    // (a real client can't send this — resolveOutcomeValid rejects it — but
    // the pick must still fail closed if it somehow did).
    const out = await pending;
    expect(selected(out)).not.toBe("allow_session");
    expect(selected(out)).toBe("deny");
  });

  test("AC-2 deny on an allow-only list cancels — never lands on an allow id", async () => {
    const r = rig();
    // No deny/reject option at all: `options[0]` would be allow_once and the
    // old last-resort fallback would turn a deny into a grant. Cancel is
    // ACP's not-granted answer.
    const pending = r.permission([
      opt("allow_once", "allow_once", "Allow once"),
      opt("allow_session", "allow_always", "Allow for session"),
      opt("allow_always", "allow_always", "Allow always"),
    ]);
    r.respond("deny");
    const out = await pending;
    expect(out.outcome.outcome).toBe("cancelled");
  });
});

/**
 * Issue #180 — ACP `plan` sessionUpdate (Hermes `todo`) maps to
 * `plan.updated` kind:"tasks" snapshots on a stable per-turn planId with
 * increasing versions; status names map onto the contracts enum.
 */
describe("engine-hermes ACP plan mapping (#180)", () => {
  const rig = () => {
    const events: { type: string; payload: unknown }[] = [];
    const engine = {} as unknown as HermesEngine;
    const driver = new AcpDriver({ bin: "hermes" }, engine);
    const session = new Session(
      "s1",
      "builder",
      "/tmp",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "acp",
      "rs1",
      "rs1",
      (e) => {
        events.push({ type: e.type, payload: e.payload });
      },
    );
    session.turn = {
      turnId: "t1",
      phase: "tools",
      resolve: () => {},
      reject: () => {},
    };
    const handler = driver as unknown as {
      onUpdate(s: Session, n: acp.SessionNotification): void;
    };
    const planUpdate = (entries: unknown[]) =>
      handler.onUpdate(session, {
        sessionId: "rs1",
        update: { sessionUpdate: "plan", entries },
      } as acp.SessionNotification);
    return { events, planUpdate };
  };

  test("AC-1 todo entries emit plan.updated kind:tasks snapshots that tick in place", () => {
    const r = rig();
    r.planUpdate([
      { content: "read README", status: "in_progress", priority: "medium" },
      { content: "edit README", status: "pending", priority: "medium" },
    ]);
    r.planUpdate([
      { content: "read README", status: "completed", priority: "medium" },
      { content: "edit README", status: "in_progress", priority: "medium" },
    ]);
    const updates = r.events.filter((e) => e.type === "plan.updated");
    expect(updates).toHaveLength(2);
    const p = updates.map(
      (e) =>
        e.payload as {
          planId: string;
          kind: string;
          version: number;
          steps: { text: string; status: string }[];
        },
    );
    // One stable planId per turn; versions increase per snapshot.
    expect(p[0].planId).toBe(p[1].planId);
    expect(p[0].planId).toContain("t1");
    expect(p.map((x) => x.version)).toEqual([1, 2]);
    expect(p[0].kind).toBe("tasks");
    expect(p[1].steps.map((s) => s.status)).toEqual([
      "completed",
      "in_progress",
    ]);
  });

  test("AC-6 unknown statuses degrade to pending; a plan update with no open turn drops", () => {
    const r = rig();
    r.planUpdate([{ content: "x", status: "weird" }]);
    const updates = r.events.filter((e) => e.type === "plan.updated");
    expect(updates).toHaveLength(1);
    expect(
      (updates[0].payload as { steps: { status: string }[] }).steps[0].status,
    ).toBe("pending");
  });
});

/**
 * Issue #309 — an async `delegate_task` keeps working after its turn ends;
   the tool call closes with a dispatch receipt (`{"status":"dispatched"}`),
   not per-task results. Synthesizing `subagent.completed` off that receipt
   falsely settles the rows — they must stay running until a real close.
 */
describe("engine-hermes ACP delegate dispatch receipt (#309)", () => {
  const rig = () => {
    const events: { type: string; payload: unknown }[] = [];
    const engine = {} as unknown as HermesEngine;
    const driver = new AcpDriver({ bin: "hermes" }, engine);
    const session = new Session(
      "s1",
      "builder",
      "/tmp",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "acp",
      "rs1",
      "rs1",
      (e) => {
        events.push({ type: e.type, payload: e.payload });
      },
    );
    session.turn = {
      turnId: "t1",
      phase: "tools",
      resolve: () => {},
      reject: () => {},
    };
    const handler = driver as unknown as {
      onUpdate(s: Session, n: acp.SessionNotification): void;
    };
    const notify = (update: Record<string, unknown>) =>
      handler.onUpdate(session, {
        sessionId: "rs1",
        update,
      } as acp.SessionNotification);
    return { events, notify, session };
  };

  test("a dispatched delegate call emits no synthesized subagent.completed", () => {
    const r = rig();
    r.notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      name: "delegate_task",
      rawInput: { tasks: [{ goal: "scan the relay" }] },
    });
    expect(r.events.filter((e) => e.type === "subagent.started")).toHaveLength(
      1,
    );
    r.notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      name: "delegate_task",
      status: "completed",
      rawOutput:
        '{"status":"dispatched","mode":"background","count":1,"delegation_id":"deleg_9f1"}',
    });
    expect(
      r.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(0);
  });

  test("a dispatch receipt arriving as a parsed object also emits no close", () => {
    const r = rig();
    r.notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      name: "delegate_task",
      rawInput: { tasks: [{ goal: "scan the relay" }] },
    });
    r.notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      name: "delegate_task",
      status: "completed",
      rawOutput: {
        status: "dispatched",
        mode: "background",
        count: 1,
        delegation_id: "deleg_9f1",
      },
    });
    expect(
      r.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(0);
  });

  test("#327 a dispatched row settles stopped when the session leaves running", () => {
    /* The row can never receive a real close over ACP — instead of
       spinning forever it settles the moment the session's own state
       says no turn can be feeding it any more. The settle is a logged
       subagent.completed, so a replay reduces the same stopped row. */
    const r = rig();
    r.notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      name: "delegate_task",
      rawInput: { tasks: [{ goal: "scan the relay" }] },
    });
    r.notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      name: "delegate_task",
      status: "completed",
      rawOutput:
        '{"status":"dispatched","mode":"background","count":1,"delegation_id":"deleg_9f1"}',
    });
    r.session.setState("running");
    expect(
      r.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(0);
    /* `waiting` is not a leave — the session is alive mid-turn (blocked
       on an open ask) and hears frames again once the ask resolves. */
    r.session.setState("waiting");
    expect(
      r.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(0);
    r.session.setState("running");
    r.session.setState("idle");
    const closed = r.events.filter((e) => e.type === "subagent.completed");
    expect(closed).toHaveLength(1);
    expect((closed[0].payload as { status: string }).status).toBe("stopped");
    /* Once — a later leave-running transition can't double-settle it. */
    r.session.setState("running");
    r.session.setState("idle");
    expect(
      r.events.filter((e) => e.type === "subagent.completed"),
    ).toHaveLength(1);
  });

  test("a synchronous delegate call still closes its synthesized rows", () => {
    const r = rig();
    r.notify({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      name: "delegate_task",
      rawInput: { tasks: [{ goal: "scan the relay" }] },
    });
    r.notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      name: "delegate_task",
      status: "completed",
      rawOutput: "Task 1 complete\n✅ Task 1: done",
    });
    const closed = r.events.filter((e) => e.type === "subagent.completed");
    expect(closed).toHaveLength(1);
    expect((closed[0].payload as { status: string }).status).toBe("done");
  });
});

/**
 * Issue #415 — ACP `usage_update.used`/`size` are the CURRENT occupancy and
 * the window, not billing totals. The `session/prompt` response's per-turn
 * usage must not clobber them at turn end.
 */
describe("engine-hermes ACP usage_update -> context/contextWindow (#415)", () => {
  const rig = () => {
    const events: { type: string; payload: unknown }[] = [];
    const engine = new HermesEngine({ gateway: new FakeGateway() });
    const driver = new AcpDriver({ bin: "hermes" }, engine);
    const session = new Session(
      "s1",
      "builder",
      "/tmp",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "acp",
      "rs1",
      "rs1",
      (e) => {
        events.push({ type: e.type, payload: e.payload });
      },
    );
    session.turn = {
      turnId: "t1",
      phase: "tools",
      resolve: () => {},
      reject: () => {},
    };
    const handler = driver as unknown as {
      onUpdate(s: Session, n: acp.SessionNotification): void;
    };
    const notify = (update: Record<string, unknown>) =>
      handler.onUpdate(session, {
        sessionId: "rs1",
        update,
      } as acp.SessionNotification);
    return { events, notify, session, engine };
  };

  test("used/size land on usage.context/contextWindow and survive endAcpTurn", () => {
    const r = rig();
    r.notify({ sessionUpdate: "usage_update", used: 41_000, size: 262_000 });
    expect(r.session.usage?.context).toBe(41_000);
    expect(r.session.usage?.contextWindow).toBe(262_000);

    r.engine.endAcpTurn(r.session, "t1", "end_turn", {
      inputTokens: 900,
      outputTokens: 300,
      thoughtTokens: 60,
      cachedReadTokens: 200,
    });
    const done = r.events.find((e) => e.type === "turn.completed");
    if (!done) throw new Error("turn.completed missing");
    const usage = (
      done.payload as {
        usage?: {
          context?: number;
          contextWindow?: number;
          input: number;
          output: number;
        };
      }
    ).usage;
    if (!usage) throw new Error("turn.completed usage missing");
    expect(usage.context).toBe(41_000);
    expect(usage.contextWindow).toBe(262_000);
    expect(usage.input).toBe(900);
    expect(usage.output).toBe(300);
  });

  test("a malformed usage_update neither clobbers a good reading nor poisons turn.completed", () => {
    const r = rig();
    r.notify({ sessionUpdate: "usage_update", used: 41_000, size: 262_000 });
    /* Strings, floats and negatives are not Usage ints — dropped, never
       written into s.usage where endAcpTurn would ship them to the
       relay's schema. */
    r.notify({ sessionUpdate: "usage_update", used: "lots", size: -1 });
    r.notify({ sessionUpdate: "usage_update", used: 41_000.5 });
    r.notify({ sessionUpdate: "usage_update" });
    expect(r.session.usage?.context).toBe(41_000);
    expect(r.session.usage?.contextWindow).toBe(262_000);

    /* A real 0 IS a reading — it replaces the stale value rather than
       being conflated with "absent". */
    r.notify({ sessionUpdate: "usage_update", used: 0 });
    expect(r.session.usage?.context).toBe(0);
  });

  test("per-turn ACP usage accumulates into the session's lifetime sums", () => {
    const r = rig();
    r.engine.endAcpTurn(r.session, "t1", "end_turn", {
      inputTokens: 900,
      outputTokens: 300,
    });
    /* ACP's prompt response is per-turn — the contract's input/output are
       lifetime sums, so the adapter accumulates them like the WS path's
       already-cumulative payload. */
    r.session.turn = {
      turnId: "t2",
      phase: "tools",
      resolve: () => {},
      reject: () => {},
    };
    r.engine.endAcpTurn(r.session, "t2", "end_turn", {
      inputTokens: 500,
      outputTokens: 200,
    });
    const dones = r.events.filter((e) => e.type === "turn.completed");
    const usage2 = (
      dones[1].payload as { usage?: { input: number; output: number } }
    ).usage;
    expect(usage2?.input).toBe(1_400);
    expect(usage2?.output).toBe(500);
  });
});
