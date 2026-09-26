import type { EngineEvent } from "@lilos/contracts/engine";
import { assert, assertMonotonic, type Harness } from "./harness.js";

export interface Scenario {
  id: string;
  run(h: Harness): Promise<void>;
}

const EDIT_PROMPT = "Fix the README title"; // edit-ask: drives mutating steps + approval
const READ_PROMPT = "Explain the relay package";

const textPrompt = (sessionId: string, text: string) => ({
  sessionId,
  content: [{ type: "text" as const, text }],
});

interface StartResult {
  sessionId: string;
}
interface PromptResult {
  turnId: string;
  stopReason: string;
}
interface SinceResult {
  events: EngineEvent[];
  latestSeq: number;
  truncated: boolean;
  openRequests: { requestId: string; seq: number }[];
  snapshot: {
    sessionId: string;
    state: string;
    turn?: { turnId: string; phase: string };
  };
}

/**
 * Answer each unresolved `request.opened` with `outcome` until
 * `turn.completed` arrives. One waiter per iteration — an already-answered
 * ask is filtered by the `request.resolved` in the backlog.
 */
async function answerAsks(
  h: Harness,
  sessionId: string,
  outcome: "once" | "always",
) {
  const answered = (requestId: string) =>
    h.events.some(
      (e) => e.type === "request.resolved" && e.payload.requestId === requestId,
    );
  for (;;) {
    const ev = await h.waitEvent(
      h.forSession(
        sessionId,
        (e) =>
          e.type === "turn.completed" ||
          (e.type === "request.opened" && !answered(e.payload.requestId)),
      ),
    );
    if (ev.type === "turn.completed") return ev;
    if (ev.type === "request.opened") {
      await h.request("request.respond", {
        sessionId,
        requestId: ev.payload.requestId,
        outcome,
      });
    }
  }
}

async function errorCode(
  h: Harness,
  method: string,
  params: unknown,
): Promise<number> {
  try {
    await h.request(method, params);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    assert(
      typeof code === "number",
      `${method} rejection must carry a numeric JSON-RPC code, got ${String(e)}`,
    );
    return code;
  }
  throw new Error(`${method} was expected to fail but resolved`);
}

/** Core conformance: every engine must pass all of these. */
export const CORE_SCENARIOS: Scenario[] = [
  {
    id: "describe returns protocol identity and capabilities",
    async run(h) {
      const r = (await h.request("describe")) as {
        name: string;
        version: string;
        protocol: { name: string; version: number };
        capabilities: { id: string; name: string }[];
      };
      assert(
        r.protocol?.name === "lilos-engine" && r.protocol?.version === 1,
        `protocol mismatch: ${JSON.stringify(r.protocol)}`,
      );
      assert(
        typeof r.name === "string" && r.name.length > 0,
        "describe needs a name",
      );
      assert(
        Array.isArray(r.capabilities),
        "describe needs a capabilities array",
      );
      for (const c of r.capabilities)
        assert(
          c.id && c.name,
          `capability missing id/name: ${JSON.stringify(c)}`,
        );
    },
  },
  {
    id: "start -> prompt -> stream -> tool -> complete",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, READ_PROMPT),
      ) as Promise<PromptResult>;
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.started"),
      );
      await h.waitEvent(
        h.forSession(
          sessionId,
          (e) => e.type === "turn.delta" && e.payload.stream === "reasoning",
        ),
      );
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "tool.started"),
      );
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "tool.completed"),
      );
      await h.waitEvent(
        h.forSession(
          sessionId,
          (e) => e.type === "turn.delta" && e.payload.stream === "text",
        ),
      );
      const done = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.completed"),
      );
      const res = await result;
      assert(
        done.type === "turn.completed" &&
          done.payload.stopReason === "end_turn",
        "turn must end end_turn",
      );
      assert(
        res.stopReason === "end_turn" && typeof res.turnId === "string",
        "prompt must resolve {turnId, stopReason}",
      );
      const events = h.events.filter((e) => e.sessionId === sessionId);
      assertMonotonic(events);
      assert(
        events[0].type === "session.started",
        "first event must be session.started",
      );
      const seqs = new Set(events.map((e) => e.seq));
      assert(seqs.size === events.length, "seq must be unique per session");
      assert(Math.min(...seqs) === 1, "seq numbering starts at 1");
    },
  },
  {
    id: "approval: request.opened -> request.respond -> tool completes",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, EDIT_PROMPT),
      ) as Promise<PromptResult>;
      const opened = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "request.opened"),
      );
      assert(opened.type === "request.opened", "expected request.opened");
      const { requestId, request } = opened.payload;
      assert(
        request.kind === "approval",
        "engine-fake's mutating steps ask approval",
      );
      assert(
        request.options.includes("once") && request.options.includes("deny"),
        "approval options include once/deny",
      );
      await h.request("request.respond", {
        sessionId,
        requestId,
        outcome: "once",
      });
      await h.waitEvent(
        h.forSession(
          sessionId,
          (e) =>
            e.type === "request.resolved" && e.payload.requestId === requestId,
        ),
      );
      // "once" covers only this ask; later mutating steps ask again — answer "always".
      const done = await answerAsks(h, sessionId, "always");
      const res = await result;
      assert(
        done.type === "turn.completed" &&
          done.payload.stopReason === "end_turn",
        "turn completes after approvals",
      );
      assert(res.stopReason === "end_turn", "prompt resolves end_turn");
      const denied = h.events.filter(
        (e) =>
          e.sessionId === sessionId &&
          e.type === "tool.completed" &&
          e.payload.status === "denied",
      );
      assert(
        denied.length === 0,
        "no tool may be denied after a once/always approval",
      );
    },
  },
  {
    id: "interrupt mid-turn resolves prompt with cancelled",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, EDIT_PROMPT),
      ) as Promise<PromptResult>;
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.delta"),
      );
      const ack = (await h.request("interrupt", { sessionId })) as {
        interrupted: boolean;
      };
      assert(
        ack.interrupted === true,
        "interrupt must report interrupted:true during a turn",
      );
      const res = await result;
      assert(
        res.stopReason === "cancelled",
        `prompt must resolve cancelled, got ${res.stopReason}`,
      );
      const done = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.completed"),
      );
      assert(
        done.type === "turn.completed" &&
          done.payload.stopReason === "cancelled",
        "turn.completed must say cancelled",
      );
      const tail = (await h.request("events.since", {
        sessionId,
        after: 0,
      })) as SinceResult;
      assert(
        tail.openRequests.length === 0,
        "interrupt must resolve pending asks",
      );
    },
  },
  {
    id: "resume mid-turn: events.since replays and returns open requests",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, EDIT_PROMPT),
      ) as Promise<PromptResult>;
      const opened = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "request.opened"),
      );
      assert(opened.type === "request.opened", "expected request.opened");
      // Reconnect: replay everything before the watermark + surface open asks.
      const since = (await h.request("events.since", {
        sessionId,
        after: opened.seq - 1,
      })) as SinceResult;
      assert(
        since.events.length >= 1 && since.events[0].seq === opened.seq,
        "replay starts right after the watermark",
      );
      assert(
        since.truncated === false,
        "short replay windows are not truncated",
      );
      assert(since.latestSeq >= opened.seq, "latestSeq covers the watermark");
      assert(
        since.openRequests.some(
          (r) => r.requestId === opened.payload.requestId,
        ),
        "openRequests must contain the pending approval",
      );
      assert(
        since.snapshot.sessionId === sessionId &&
          since.snapshot.state === "waiting",
        "snapshot shows a waiting session",
      );
      assert(
        since.snapshot.turn?.phase === "waiting",
        "snapshot turn phase is waiting",
      );
      await h.request("request.respond", {
        sessionId,
        requestId: opened.payload.requestId,
        outcome: "always",
      });
      const res = await result;
      assert(
        res.stopReason === "end_turn",
        "turn completes after the resumed approval",
      );
      const tail = (await h.request("events.since", {
        sessionId,
        after: since.latestSeq,
      })) as SinceResult;
      assert(tail.openRequests.length === 0, "no open requests after resolve");
    },
  },
  {
    id: "follow-up prompts reuse the same session",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const r1 = (await h.request(
        "prompt",
        textPrompt(sessionId, READ_PROMPT),
      )) as PromptResult;
      const r2 = (await h.request(
        "prompt",
        textPrompt(sessionId, "What about the tests"),
      )) as PromptResult;
      assert(
        r1.stopReason === "end_turn" && r2.stopReason === "end_turn",
        "both turns complete",
      );
      assert(r1.turnId !== r2.turnId, "each prompt gets its own turnId");
      const since = (await h.request("events.since", {
        sessionId,
        after: 0,
      })) as SinceResult;
      assertMonotonic(since.events);
      assert(
        since.events.filter((e) => e.type === "turn.completed").length === 2,
        "log holds both turns",
      );
    },
  },
  {
    id: "protocol errors map to JSON-RPC codes",
    async run(h) {
      assert(
        (await errorCode(h, "no.such.method", {})) === -32601,
        "unknown method -> -32601",
      );
      assert(
        (await errorCode(h, "session.start", { agent: 1 })) === -32602,
        "bad params -> -32602",
      );
      assert(
        (await errorCode(h, "events.since", {
          sessionId: "nope",
          after: 0,
        })) === -32001,
        "unknown session -> -32001",
      );
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      assert(
        (await errorCode(h, "request.respond", {
          sessionId,
          requestId: "nope",
          outcome: "once",
        })) === -32002,
        "unknown request -> -32002",
      );
    },
  },
  {
    id: "session.stop closes the session but keeps the log",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const stopped = (await h.request("session.stop", { sessionId })) as {
        stopped: boolean;
      };
      assert(stopped.stopped === true, "stop reports stopped:true");
      assert(
        (await errorCode(h, "prompt", textPrompt(sessionId, READ_PROMPT))) ===
          -32003,
        "prompt on closed session -> -32003",
      );
      const since = (await h.request("events.since", {
        sessionId,
        after: 0,
      })) as SinceResult;
      assert(
        since.events.some(
          (e) => e.type === "session.state" && e.payload.state === "closed",
        ),
        "closed state is replayable",
      );
    },
  },
];

/** Capability suites beyond core. Only scenarios for capabilities engine-fake declares are implemented. */
export const STEER_SCENARIOS: Scenario[] = [
  {
    id: "steer lands at a tool boundary",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, EDIT_PROMPT),
      ) as Promise<PromptResult>;
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "tool.started"),
      );
      const ack = (await h.request("session.steer", {
        sessionId,
        text: "also check the footer",
      })) as { status: string };
      assert(ack.status === "steered", "mid-turn steer reports steered");
      // The steer lands at the next tool boundary, which sits behind a pending
      // approval — answer asks while the steered frame is on its way.
      const steered = h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.steered"),
      );
      await answerAsks(h, sessionId, "always");
      const steeredEvent = await steered;
      assert(
        steeredEvent.type === "turn.steered" &&
          steeredEvent.payload.text === "also check the footer",
        "turn.steered carries the text",
      );
      const res = await result;
      assert(res.stopReason === "end_turn", "steered turn still completes");
    },
  },
];

/**
 * Suite registry: `core` always runs; each capability the engine declares on
 * `describe` adds its suite. Pending suites are registered so engines (and CI)
 * can list them; they are intentionally empty until the capability lands.
 */
export const SUITES: {
  capability: string;
  implemented: boolean;
  scenarios: Scenario[];
}[] = [
  { capability: "core", implemented: true, scenarios: CORE_SCENARIOS },
  { capability: "steer", implemented: true, scenarios: STEER_SCENARIOS },
  { capability: "image_prompt", implemented: false, scenarios: [] },
  { capability: "mcp_servers", implemented: false, scenarios: [] },
  { capability: "models", implemented: false, scenarios: [] },
  { capability: "agents", implemented: false, scenarios: [] },
  { capability: "usage", implemented: false, scenarios: [] },
  { capability: "plan", implemented: false, scenarios: [] },
  { capability: "rewind", implemented: false, scenarios: [] },
];
