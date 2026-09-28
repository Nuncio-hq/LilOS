import type { EngineEvent } from "@lilos/contracts/engine";
import { assert, assertMonotonic, type Harness } from "./harness.js";

export interface Scenario {
  id: string;
  run(h: Harness): Promise<void>;
}

/**
 * #50 AC-2 — prompts a real model follows deterministically: one bounded
 * action plus an exact reply, so a live turn can't loop tools until the
 * scenario timeout. The marker phrases keep the canned paths green: the
 * engine-fake script keys on edit verbs, the live OpenAI stub on
 * "Fix the README title" / "Explain the relay package" / "LILOS_SLOW" /
 * "LILOS_LONG" / "chmod 777".
 */
const EDIT_PROMPT =
  "Fix the README title: edit README.md exactly once (a single mutating tool call), then reply with exactly: LILOS_OK";
const READ_PROMPT =
  "Explain the relay package: call exactly one read or search tool, then reply with exactly: LILOS_OK";
/** Long streaming window — a stable mid-turn point for interrupt on a real model. */
const SLOW_PROMPT =
  "LILOS_SLOW — write a story of at least 300 words about a lighthouse keeper, then reply with exactly: LILOS_OK";
/** Long streaming window without mutating tools — for the late-steer scenario. */
const LONG_READ_PROMPT =
  "LILOS_SLOW — explain the relay package in at least 200 words, then reply with exactly: LILOS_OK";

/**
 * #63 AC-1/AC-2 — a real engine never asks approval for a file edit; it asks
 * for a terminal command its dangerous-command detector flags
 * (`tools/approval_detection.py` DANGEROUS_PATTERNS — `chmod 777` matches
 * "world/other-writable permissions", enforced by `check_all_command_guards`
 * under `approvals.mode: manual` in a gateway context, which emits the
 * `srq-*` approval request). The prompt makes the model run that command
 * verbatim in the scratch cwd; the leading "Change" keeps engine-fake on its
 * mutating script (those steps ask approval too), and `openai_stub.py` emits
 * the same `terminal` tool call a real model sends.
 */
export const APPROVAL_PROMPT =
  "Change permissions on README.md: run this terminal command verbatim — `chmod 777 README.md` — then reply with exactly: LILOS_OK";

/**
 * The prompt each live-trigger scenario drives, keyed by scenario id; the
 * scenario bodies read `SCENARIO_LIVE_PROMPTS[this.id]` so this table *is*
 * the wiring AC-1/AC-2 test.
 */
export const SCENARIO_LIVE_PROMPTS: Record<string, string> = {
  "approval: request.opened -> request.respond -> tool completes":
    APPROVAL_PROMPT,
  "resume mid-turn: events.since replays and returns open requests":
    APPROVAL_PROMPT,
  "approval over mcp_servers: 'always' grants permanently, no re-ask":
    APPROVAL_PROMPT,
};

/**
 * #76 AC-1 — foldable mass rides in the PASTED user text, not the model's
 * reply: a real model answers an acknowledge prompt in a few tokens, and the
 * engine refuses any fold whose summary would not shrink the transcript
 * (commit-site anti-growth guard -> `removed: 0` -> no ref rotation; the
 * observed failure this issue fixes). The summary re-quotes folded user
 * messages verbatim only up to a capped per-message/total budget and the
 * anchor index is likewise capped, so ~64KB of paste per turn stays foldable
 * even against the largest possible summary plus a verbatim tail window. The
 * model is only asked for `LILOS_OK`, so the leg is fast on a real build and
 * identical on the stub.
 */
export const COMPRESS_FILLER_TURNS = 6;
/** Bytes of pasted foldable mass per filler turn (~16K rough tokens). */
export const COMPRESS_FILLER_BYTES = 64 * 1024;

// Deterministic word stream — identical bytes on every run, in tests and on
// the stub — spelled to stay out of the summary's mechanical anchor index
// (no digits, `#id`s, urls, paths, `@handle`s, hex runs or capitalized
// Error words, which a real engine harvests and re-quotes verbatim).
const FILLER_LEXICON =
  "amber anvil apron arrow aspen atlas autumn beacon birch breeze brook canyon cedar cipher cliff clover cobalt comet copper coral creek cricket crystal cypress dagger dawn delta desert dolphin ember fable falcon feather flint forest forge fossil garnet glacier grove harbor hazel heron hollow island ivory jasper juniper lagoon laurel lilac linen lunar magma maple marble meadow mercury mesa mistral moss nectar north oaken olive onyx opal orchard otter paddle pebble pepper pine plume quartz raven reef river robin saddle saffron sage salmon silver solar summit timber topaz tulip umber velvet violet walnut willow winter wren yellow zephyr".split(
    " ",
  );

const fillerBlock = (turn: number): string => {
  // xorshift32 keyed by turn — no Math.random: every caller sees the same paste.
  let x = Math.imul(turn + 1, 0x9e3779b9);
  const parts: string[] = [];
  let bytes = 0;
  while (bytes < COMPRESS_FILLER_BYTES) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = FILLER_LEXICON[(x >>> 0) % FILLER_LEXICON.length];
    parts.push(w);
    bytes += w.length + 1;
  }
  return parts.join(" ");
};

export const compressFillerPrompt = (i: number): string =>
  `Context builder ${i}: the block below is pasted reference text for this session — acknowledge it, do not summarize or repeat it. Reply with exactly: LILOS_OK\n\n${fillerBlock(i)}`;

const textPrompt = (sessionId: string, text: string) => ({
  sessionId,
  content: [{ type: "text" as const, text }],
});

interface StartResult {
  sessionId: string;
}
interface DescribeResultShape {
  name: string;
  version: string;
  capabilities: { id: string; methods?: string[] }[];
}
interface AgentRow {
  id: string;
  name: string;
  description?: string;
  model?: string;
  skillCount?: number;
  soul?: string;
}
interface ModelRow {
  id: string;
  name?: string;
  provider?: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
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
      // Approvals take once/always; clarifies take an answer. A real model
      // can open either kind mid-turn.
      if (ev.payload.request.kind === "question") {
        await h.request("request.respond", {
          sessionId,
          requestId: ev.payload.requestId,
          outcome: "answer",
          answer: "proceed",
        });
      } else {
        await h.request("request.respond", {
          sessionId,
          requestId: ev.payload.requestId,
          outcome,
        });
      }
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
      // Any streamed content proves the stream (a real model may not expose
      // a reasoning channel, and may answer without a separate text delta).
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.delta"),
      );
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "tool.started"),
      );
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "tool.completed"),
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
    },
  },
  {
    id: "prompt.ref echoes back on turn.started (#28 dedupe key)",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request("prompt", {
        ...textPrompt(sessionId, READ_PROMPT),
        ref: "msg_deadbeef",
      }) as Promise<PromptResult>;
      const started = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.started"),
      );
      assert(
        started.type === "turn.started" &&
          (started.payload as { ref?: string }).ref === "msg_deadbeef",
        `turn.started must echo prompt.ref, got ${JSON.stringify(started.payload)}`,
      );
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.completed"),
      );
      await result;
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
        textPrompt(sessionId, SCENARIO_LIVE_PROMPTS[this.id]),
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
      const resolved = await h.waitEvent(
        h.forSession(
          sessionId,
          (e) =>
            e.type === "request.resolved" && e.payload.requestId === requestId,
        ),
      );
      // #133 AC-3 — the engine echoes back the outcome it actually granted;
      // a downgrade (or upgrade) surfaces here instead of silently sticking.
      assert(
        resolved.type === "request.resolved" &&
          resolved.payload.outcome === "once",
        "request.resolved must echo the chosen option",
      );
      // "once" covers only this ask; later gated steps ask again and get
      // "once" too — "always" would persist the pattern to the profile's
      // `command_allowlist`, auto-approving it on every later run (#63).
      const done = await answerAsks(h, sessionId, "once");
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
        textPrompt(sessionId, SLOW_PROMPT),
      ) as Promise<PromptResult>;
      // A long stream (or a parked approval ask) is the deterministic
      // mid-turn window — a short real-model reply could finish first.
      await h.waitEvent(
        h.forSession(
          sessionId,
          (e) => e.type === "turn.delta" || e.type === "request.opened",
        ),
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
        textPrompt(sessionId, SCENARIO_LIVE_PROMPTS[this.id]),
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
      // "once", never "always" — a permanent allowlist entry would
      // auto-approve the trigger command on reruns (#63). Later asks in the
      // same turn get "once" each.
      await h.request("request.respond", {
        sessionId,
        requestId: opened.payload.requestId,
        outcome: "once",
      });
      await answerAsks(h, sessionId, "once");
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
        textPrompt(
          sessionId,
          "What about the tests — reply with exactly: LILOS_OK",
        ),
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
    id: "describe wires session.steer under the steer capability",
    async run(h) {
      const r = (await h.request("describe")) as {
        capabilities: { id: string; methods?: string[] }[];
      };
      const steer = r.capabilities.find((c) => c.id === "steer");
      assert(steer, "steer suite runs only against engines declaring steer");
      assert(
        steer?.methods?.includes("session.steer") === true,
        "the steer descriptor names session.steer",
      );
    },
  },
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
      // A parked approval ask is the stable boundary a real model always
      // reaches under manual approvals; tool.started covers engines that
      // auto-approve (either means the turn is mid-flight).
      await h.waitEvent(
        h.forSession(
          sessionId,
          (e) => e.type === "request.opened" || e.type === "tool.started",
        ),
      );
      const ack = (await h.request("session.steer", {
        sessionId,
        text: "also check the footer",
      })) as { status: string };
      if (ack.status === "not_running") {
        // The bounded turn finished before the steer landed — the contract
        // says the client sends the text as a normal prompt instead.
        const res = (await h.request(
          "prompt",
          textPrompt(
            sessionId,
            "also check the footer — reply with exactly: LILOS_OK",
          ),
        )) as PromptResult;
        assert(res.stopReason === "end_turn", "the deferred steer completes");
        await result;
        return;
      }
      assert(ack.status === "steered", "mid-turn steer reports steered");
      // The steer lands at the next tool boundary, which may sit behind a
      // pending approval — answer asks while the steered frame is on its way.
      const steered = h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.steered"),
      );
      await answerAsks(h, sessionId, "once");
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
  {
    id: "several steers land in order at one boundary",
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
        h.forSession(
          sessionId,
          (e) => e.type === "request.opened" || e.type === "tool.started",
        ),
      );
      const steeredTexts = [
        "first: adjust the header",
        "second: bump the tests",
      ];
      const queued: string[] = [];
      for (const text of steeredTexts) {
        const ack = (await h.request("session.steer", {
          sessionId,
          text,
        })) as { status: string };
        if (ack.status === "not_running") continue;
        assert(ack.status === "steered", `steer "${text}" reports steered`);
        queued.push(text);
      }
      await answerAsks(h, sessionId, "once");
      const res = await result;
      assert(res.stopReason === "end_turn", "steered turn still completes");
      const landed = h.events.filter(
        (e): e is Extract<EngineEvent, { type: "turn.steered" }> =>
          e.sessionId === sessionId &&
          e.type === "turn.steered" &&
          e.payload.turnId === res.turnId,
      );
      // A bounded real-model turn may end between the two acks: the ones the
      // engine accepted must still land FIFO on that turn.
      assert(
        landed.length === queued.length &&
          queued.every((t, i) => landed[i].payload.text === t),
        `steers land FIFO, got ${JSON.stringify(landed.map((e) => e.payload.text))}`,
      );
    },
  },
  {
    id: "a steer accepted late in the turn is never lost",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const result = h.request(
        "prompt",
        textPrompt(sessionId, LONG_READ_PROMPT),
      ) as Promise<PromptResult>;
      // Steer once the reply is streaming: past the last tool boundary on a
      // deterministic engine; a live engine may still land it — or the turn
      // may already be over, in which case not_running means "send a prompt".
      await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.delta"),
      );
      const steerText = "then summarize the engine packages";
      const ack = (await h.request("session.steer", {
        sessionId,
        text: steerText,
      })) as { status: string };
      if (ack.status === "not_running") {
        const res = (await h.request(
          "prompt",
          textPrompt(
            sessionId,
            "then summarize the engine packages — reply with exactly: LILOS_OK",
          ),
        )) as PromptResult;
        assert(
          res.stopReason === "end_turn",
          "a steer refused as not_running becomes a normal prompt",
        );
        await result;
        return;
      }
      assert(ack.status === "steered", "late steer still reports steered");
      const first = await result;
      assert(
        first.stopReason === "end_turn",
        "the turn the steer was sent during still completes",
      );
      // The contract is "never lost": either it landed inside the turn as a
      // turn.steered event, or the engine runs it as the next turn on its own.
      const landedInTurn = h.events.some(
        (e) =>
          e.sessionId === sessionId &&
          e.type === "turn.steered" &&
          e.payload.turnId === first.turnId &&
          e.payload.text === steerText,
      );
      if (landedInTurn) return;
      const next = await h.waitEvent(
        h.forSession(
          sessionId,
          (e) => e.type === "turn.started" && e.payload.turnId !== first.turnId,
        ),
      );
      assert(
        next.type === "turn.started" && next.payload.turnId !== first.turnId,
        "the missed steer gets its own turn",
      );
      const done = await h.waitEvent(
        h.forSession(
          sessionId,
          (e) =>
            e.type === "turn.completed" &&
            e.payload.turnId === next.payload.turnId,
        ),
      );
      assert(
        done.type === "turn.completed" &&
          done.payload.stopReason === "end_turn",
        "the follow-up steer turn completes",
      );
    },
  },
  {
    id: "steer on an idle session reports not_running and consumes nothing",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const ack = (await h.request("session.steer", {
        sessionId,
        text: "nobody is working on this",
      })) as { status: string };
      assert(ack.status === "not_running", "idle steer reports not_running");
      // not_running consumed nothing — the client is expected to send prompt.
      // A consumed steer would have started a turn on its own.
      await new Promise((r) => setTimeout(r, 50));
      assert(
        !h.events.some(
          (e) => e.sessionId === sessionId && e.type === "turn.started",
        ),
        "a not_running steer must not start a turn",
      );
      const res = (await h.request(
        "prompt",
        textPrompt(sessionId, READ_PROMPT),
      )) as PromptResult;
      assert(
        res.stopReason === "end_turn",
        "the client can still prompt the idle session",
      );
      assert(
        h.events.filter(
          (e) => e.sessionId === sessionId && e.type === "turn.started",
        ).length === 1,
        "only the prompt's turn ever ran",
      );
    },
  },
  {
    id: "steer errors follow the protocol codes",
    async run(h) {
      assert(
        (await errorCode(h, "session.steer", {
          sessionId: "no-such-session",
          text: "hello",
        })) === -32001,
        "steer on an unknown session -> SESSION_NOT_FOUND",
      );
      assert(
        (await errorCode(h, "session.steer", {
          sessionId: "no-such-session",
          text: "",
        })) === -32602,
        "empty steer text -> INVALID_PARAMS",
      );
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      await h.request("session.stop", { sessionId });
      assert(
        (await errorCode(h, "session.steer", {
          sessionId,
          text: "too late",
        })) === -32003,
        "steer on a closed session -> INVALID_STATE",
      );
    },
  },
];

/**
 * `image_prompt` capability (issue #31): image content blocks ride `prompt`
 * beside text. The protocol guarantee is that the block is accepted and the
 * turn completes — what an engine answers about the pixels is its own affair
 * (engine-fake echoes the metadata it received; a vision model describes it).
 */
export const IMAGE_PROMPT_SCENARIOS: Scenario[] = [
  {
    id: "describe wires image content blocks under the image_prompt capability",
    async run(h) {
      const r = (await h.request("describe")) as {
        capabilities: { id: string; methods?: string[] }[];
      };
      const cap = r.capabilities.find((c) => c.id === "image_prompt");
      assert(cap, "image_prompt suite runs only against engines declaring it");
      assert(
        cap?.methods?.includes("prompt") === true,
        "the image_prompt descriptor names prompt",
      );
    },
  },
  {
    id: "an image content block rides the prompt and the turn completes",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      // 1x1 PNG — tiny but a real image payload.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const res = (await h.request("prompt", {
        sessionId,
        content: [
          { type: "text", text: "what does this screenshot show" },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      })) as PromptResult;
      assert(
        res.stopReason === "end_turn",
        `image prompt completes end_turn, got ${res.stopReason}`,
      );
      const streamed = h.events.some(
        (e) =>
          e.sessionId === sessionId &&
          e.type === "turn.delta" &&
          e.payload.stream === "text",
      );
      assert(streamed, "the image turn streams an answer");
    },
  },
  {
    id: "an image-only prompt is a valid prompt",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      // Oscar drops a screenshot with no caption — no text block at all.
      const res = (await h.request("prompt", {
        sessionId,
        content: [
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            mimeType: "image/png",
          },
        ],
      })) as PromptResult;
      assert(
        res.stopReason === "end_turn",
        `image-only prompt completes end_turn, got ${res.stopReason}`,
      );
    },
  },
];

/**
 * `agents` capability: the hire dialog's data path. Scenarios carry the issue
 * AC number they prove (the dialog itself is another slice's UI work).
 */
export const AGENTS_SCENARIOS: Scenario[] = [
  {
    id: "AC-1 agents.list returns hireable agent descriptors",
    async run(h) {
      const d = (await h.request("describe")) as DescribeResultShape;
      const cap = d.capabilities.find((c) => c.id === "agents");
      assert(cap, "engine must declare the agents capability");
      for (const m of ["agents.list", "agents.describe", "agents.create"])
        assert(cap.methods?.includes(m), `agents capability must enable ${m}`);
      const r = (await h.request("agents.list")) as { agents: AgentRow[] };
      assert(
        Array.isArray(r.agents) && r.agents.length >= 1,
        "agents.list needs at least one agent",
      );
      for (const a of r.agents) {
        assert(
          typeof a.id === "string" && a.id.length > 0,
          `agent row needs a non-empty id: ${JSON.stringify(a)}`,
        );
        assert(
          typeof a.name === "string" && a.name.length > 0,
          `agent row needs a display name: ${JSON.stringify(a)}`,
        );
        if (a.skillCount !== undefined)
          assert(
            Number.isInteger(a.skillCount) && a.skillCount >= 0,
            "skillCount is a non-negative int",
          );
      }
      const again = (await h.request("agents.list")) as { agents: AgentRow[] };
      assert(
        again.agents.map((a) => a.id).join() ===
          r.agents.map((a) => a.id).join(),
        "agent ids are stable across calls",
      );
    },
  },
  {
    id: "AC-1 agents.describe returns the persona; unknown ids are refused",
    async run(h) {
      const { agents } = (await h.request("agents.list")) as {
        agents: AgentRow[];
      };
      const r = (await h.request("agents.describe", { id: agents[0].id })) as {
        agent: AgentRow;
      };
      assert(
        r.agent?.id === agents[0].id,
        "describe returns the same agent id",
      );
      assert(
        r.agent.soul === undefined || typeof r.agent.soul === "string",
        "soul is a string when present",
      );
      assert(
        (await errorCode(h, "agents.describe", { id: "no-such-agent" })) ===
          -32004,
        "agents.describe unknown id -> AGENT_NOT_FOUND (-32004)",
      );
      assert(
        (await errorCode(h, "session.start", {
          agent: "no-such-agent",
          cwd: "/tmp/lilos-conf",
        })) === -32004,
        "session.start unknown agent -> AGENT_NOT_FOUND (-32004)",
      );
    },
  },
  {
    id: "AC-2 agents.create registers a real agent (list + describe see it)",
    async run(h) {
      // Distinct per run: engines must persist created profiles (no delete
      // exists), so a fixed name would collide on rerun.
      const name = `lilos-conformance-${Math.random().toString(36).slice(2, 8)}`;
      const created = (await h.request("agents.create", {
        name,
        description: "conformance probe agent",
        soul: "A deterministic conformance agent.",
      })) as { agent: AgentRow };
      assert(
        typeof created.agent?.id === "string" && created.agent.id.length > 0,
        "create returns the registered descriptor",
      );
      const { agents } = (await h.request("agents.list")) as {
        agents: AgentRow[];
      };
      assert(
        agents.some((a) => a.id === created.agent.id || a.name === name),
        "agents.list sees the created agent",
      );
      const d = (await h.request("agents.describe", {
        id: created.agent.id,
      })) as { agent: AgentRow };
      assert(d.agent.name === name, "agents.describe sees the created agent");
      const code = await errorCode(h, "agents.create", { name });
      assert(
        code === -32003 || code === -32602,
        `duplicate name create must fail (-32003/-32602), got ${code}`,
      );
    },
  },
  {
    id: "AC-4 the protocol has no profile delete",
    async run(h) {
      for (const m of ["agents.delete", "agents.remove", "agent.delete"])
        assert(
          (await errorCode(h, m, { id: "x" })) === -32601,
          `${m} must not exist — LilOS never deletes profiles`,
        );
    },
  },
];

/**
 * `models` capability: the model picker's data path and the "next turn uses
 * the picked one" guarantee (via `turn.started.model`).
 */
export const MODELS_SCENARIOS: Scenario[] = [
  {
    id: "AC-3 models.list returns the selectable model set",
    async run(h) {
      const d = (await h.request("describe")) as DescribeResultShape;
      const cap = d.capabilities.find((c) => c.id === "models");
      assert(cap, "engine must declare the models capability");
      for (const m of ["models.list", "session.setModel"])
        assert(cap.methods?.includes(m), `models capability must enable ${m}`);
      const r = (await h.request("models.list")) as {
        models: ModelRow[];
        default?: string;
      };
      assert(
        Array.isArray(r.models) && r.models.length >= 1,
        "models.list needs at least one model",
      );
      for (const m of r.models)
        assert(
          typeof m.id === "string" && m.id.length > 0,
          `model option needs a non-empty id: ${JSON.stringify(m)}`,
        );
      if (r.default !== undefined)
        assert(
          r.models.some((m) => m.id === r.default),
          "default must be one of the listed ids",
        );
      // #92: per-model data rides the same rows — when present, `efforts` is a
      // non-empty ordered list, `defaultEffort` one of its stops.
      for (const m of r.models) {
        if (m.efforts !== undefined)
          assert(
            Array.isArray(m.efforts) && m.efforts.length > 0,
            `efforts must be a non-empty list: ${JSON.stringify(m)}`,
          );
        if (m.defaultEffort !== undefined && m.efforts !== undefined)
          assert(
            m.efforts.includes(m.defaultEffort),
            `defaultEffort must be one of efforts: ${JSON.stringify(m)}`,
          );
        if (m.provider !== undefined)
          assert(
            typeof m.provider === "string" && m.provider.length > 0,
            `provider must be a non-empty slug: ${JSON.stringify(m)}`,
          );
      }
    },
  },
  {
    id: "AC-6 models.list honors refresh when the capability declares it",
    async run(h) {
      const d = (await h.request("describe")) as {
        capabilities?: { id: string; detail?: { refreshable?: boolean } }[];
      };
      const cap = d.capabilities?.find((c) => c.id === "models");
      const detail = cap?.detail;
      if (detail?.refreshable !== true) {
        // No declared refresh path — the engine may still accept the param,
        // but conformance only requires it not to break.
        await h.request("models.list", { refresh: true });
        return;
      }
      const fresh = (await h.request("models.list", {
        refresh: true,
      })) as { models: ModelRow[] };
      assert(
        Array.isArray(fresh.models) && fresh.models.length >= 1,
        "a refreshable catalog must still return models on refresh:true",
      );
    },
  },
  {
    id: "AC-3 session.setModel makes the next turn use the picked model",
    async run(h) {
      const { models, default: dflt } = (await h.request("models.list")) as {
        models: ModelRow[];
        default?: string;
      };
      const picked = models.find((m) => m.id !== dflt) ?? models[0];
      // When the engine also declares `agents`, start as a real agent id.
      const d = (await h.request("describe")) as DescribeResultShape;
      let agent = "builder";
      if (d.capabilities.some((c) => c.id === "agents")) {
        const { agents } = (await h.request("agents.list")) as {
          agents: AgentRow[];
        };
        agent = agents[0].id;
      }
      const { sessionId } = (await h.request("session.start", {
        agent,
        cwd: "/tmp/lilos-conf",
      })) as StartResult;
      const ack = (await h.request("session.setModel", {
        sessionId,
        model: picked.id,
      })) as { model: string };
      assert(
        ack.model === picked.id,
        `setModel echoes the pinned model, got ${ack.model}`,
      );
      const result = h.request(
        "prompt",
        textPrompt(sessionId, READ_PROMPT),
      ) as Promise<PromptResult>;
      const started = await h.waitEvent(
        h.forSession(sessionId, (e) => e.type === "turn.started"),
      );
      assert(
        started.type === "turn.started" && started.payload.model === picked.id,
        `turn.started.model must be the picked model, got ${JSON.stringify(started.payload)}`,
      );
      const res = await result;
      assert(res.stopReason === "end_turn", "the turn still completes");
    },
  },
  {
    id: "AC-3 session.setModel errors map to codes",
    async run(h) {
      assert(
        (await errorCode(h, "session.setModel", {
          sessionId: "nope",
          model: "x",
        })) === -32001,
        "unknown session -> SESSION_NOT_FOUND (-32001)",
      );
      const d = (await h.request("describe")) as DescribeResultShape;
      let agent = "builder";
      if (d.capabilities.some((c) => c.id === "agents")) {
        const { agents } = (await h.request("agents.list")) as {
          agents: AgentRow[];
        };
        agent = agents[0].id;
      }
      const { sessionId } = (await h.request("session.start", {
        agent,
        cwd: "/tmp/lilos-conf",
      })) as StartResult;
      assert(
        (await errorCode(h, "session.setModel", {
          sessionId,
          model: "no-such-model",
        })) === -32005,
        "unknown model -> MODEL_NOT_FOUND (-32005)",
      );
      await h.request("session.stop", { sessionId });
      const { models } = (await h.request("models.list")) as {
        models: ModelRow[];
      };
      assert(
        (await errorCode(h, "session.setModel", {
          sessionId,
          model: models[0].id,
        })) === -32003,
        "closed session -> INVALID_STATE (-32003)",
      );
    },
  },
];

/**
 * `session_meta` capability (#28): rename/archive in the UI map to the
 * engine's own title/hidden so engine-side tooling sees the same names.
 */
const SESSION_META_SCENARIOS: Scenario[] = [
  {
    id: "session.setTitle returns the new title, session.setHidden the flag",
    async run(h) {
      const { sessionId } = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const titled = (await h.request("session.setTitle", {
        sessionId,
        title: "Quarterly plan",
      })) as { title: string };
      assert(
        titled.title === "Quarterly plan",
        `setTitle must echo the new title, got ${JSON.stringify(titled)}`,
      );
      const hidden = (await h.request("session.setHidden", {
        sessionId,
        hidden: true,
      })) as { hidden: boolean };
      assert(hidden.hidden === true, "setHidden(true) must return true");
      const shown = (await h.request("session.setHidden", {
        sessionId,
        hidden: false,
      })) as { hidden: boolean };
      assert(shown.hidden === false, "setHidden(false) must return false");
    },
  },
];

/**
 * Minimal MCP stdio server, inlined as a `python3 -c` program so the scenario
 * stays self-contained (a package file can't assume a repo-relative path the
 * engine's cwd will resolve). It answers the `session/new` handshake —
 * initialize, tools/list, tools/call, ping — and nothing else.
 */
const MCP_NOOP_SERVER = `import json, sys

RESPONDERS = {
    "initialize": lambda p: {
        "protocolVersion": p.get("protocolVersion", "2025-03-26"),
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "lilos-noop", "version": "0"},
    },
    "tools/list": lambda p: {"tools": []},
    "tools/call": lambda p: {
        "isError": True,
        "content": [{"type": "text", "text": "lilos-noop has no tools"}],
    },
    "ping": lambda p: {},
}

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("id") is None:
        continue
    fn = RESPONDERS.get(msg.get("method"))
    out = {"jsonrpc": "2.0", "id": msg["id"]}
    if fn is None:
        out["error"] = {"code": -32601, "message": "method not found"}
    else:
        out["result"] = fn(msg.get("params") or {})
    sys.stdout.write(json.dumps(out) + "\\n")
    sys.stdout.flush()
`;

/**
 * `mcp_servers` capability: a `session.start` that carries stdio MCP servers.
 * On Hermes that routes the session onto the ACP transport (`hermes acp`),
 * where #133 lived — the fake accepts the same sessions inertly.
 */
const MCP_SCENARIOS: Scenario[] = [
  {
    id: "approval over mcp_servers: 'always' grants permanently, no re-ask",
    async run(h) {
      // Leg 1 — mcpServers session (ACP transport on Hermes). Its option
      // list carries two `allow_always`-kind entries and the session-scoped
      // `allow_session` sorts first; answering "always" must pick the
      // permanent `allow_always` id, not the first kind match.
      const s1 = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
        mcpServers: [
          {
            name: "noop",
            command: "python3",
            args: ["-c", MCP_NOOP_SERVER],
            env: [],
          },
        ],
      })) as StartResult;
      const turn1 = h.request(
        "prompt",
        textPrompt(s1.sessionId, SCENARIO_LIVE_PROMPTS[this.id]),
      ) as Promise<PromptResult>;
      const opened = await h.waitEvent(
        h.forSession(s1.sessionId, (e) => e.type === "request.opened"),
      );
      assert(opened.type === "request.opened", "gated step opens an ask");
      const { requestId, request } = opened.payload;
      assert(request.kind === "approval", "gated step opens an approval ask");
      for (const o of ["once", "always", "deny"])
        assert(
          (request.options as string[]).includes(o),
          `the approval card offers "${o}"`,
        );
      await h.request("request.respond", {
        sessionId: s1.sessionId,
        requestId,
        outcome: "always",
      });
      const resolved = await h.waitEvent(
        h.forSession(
          s1.sessionId,
          (e) =>
            e.type === "request.resolved" && e.payload.requestId === requestId,
        ),
      );
      assert(
        resolved.type === "request.resolved" &&
          resolved.payload.outcome === "always",
        "the chosen 'always' round-trips through the transport",
      );
      const done1 = await answerAsks(h, s1.sessionId, "always");
      const r1 = await turn1;
      assert(
        done1.type === "turn.completed" && r1.stopReason === "end_turn",
        "leg-1 turn completes on the grant",
      );

      // Leg 2 — a fresh session on the plain transport re-runs the same
      // command. A real `allow_always` grant survives the session that made
      // it, so nothing may re-ask; the session-scoped `allow_session` grant
      // the bug picked dies with leg 1 and re-opens the ask here.
      const s2 = (await h.request("session.start", {
        agent: "builder",
        cwd: "/tmp/lilos-fake",
      })) as StartResult;
      const turn2 = h.request(
        "prompt",
        textPrompt(s2.sessionId, SCENARIO_LIVE_PROMPTS[this.id]),
      ) as Promise<PromptResult>;
      const ev2 = await h.waitEvent(
        h.forSession(
          s2.sessionId,
          (e) => e.type === "turn.completed" || e.type === "request.opened",
        ),
      );
      assert(
        ev2.type === "turn.completed",
        `an always-granted command must not re-ask in a new session (got ${ev2.type})`,
      );
      const r2 = await turn2;
      assert(r2.stopReason === "end_turn", "leg-2 turn completes");
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
  {
    capability: "image_prompt",
    implemented: true,
    scenarios: IMAGE_PROMPT_SCENARIOS,
  },
  {
    capability: "mcp_servers",
    implemented: true,
    scenarios: MCP_SCENARIOS,
  },
  { capability: "models", implemented: true, scenarios: MODELS_SCENARIOS },
  { capability: "agents", implemented: true, scenarios: AGENTS_SCENARIOS },
  {
    capability: "session_meta",
    implemented: true,
    scenarios: SESSION_META_SCENARIOS,
  },
  { capability: "usage", implemented: false, scenarios: [] },
  { capability: "plan", implemented: false, scenarios: [] },
  { capability: "rewind", implemented: false, scenarios: [] },
];
