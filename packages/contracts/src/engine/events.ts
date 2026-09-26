import { z } from "zod";
import { ApprovalOutcome, EngineRequest } from "./requests.js";

/**
 * Events v1 — every frame the engine pushes is a JSON-RPC notification
 * `{"jsonrpc":"2.0","method":"event","params":<EngineEvent>}`. `seq` is a
 * per-session monotonic counter starting at 1; `events.since` replays the
 * frames after a watermark, so the union below is the whole replayable
 * surface. Payloads are strict (unknown keys are a producer bug).
 */

const Seq = z.int().min(1);
const SessionId = z.string().min(1);
const TurnId = z.string().min(1);

export const StopReason = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
export type StopReason = z.infer<typeof StopReason>;

export const Usage = z.object({
  input: z.int().min(0),
  output: z.int().min(0),
  reasoning: z.int().min(0),
  cache: z.int().min(0),
});
export type Usage = z.infer<typeof Usage>;

export const SessionState = z.enum([
  "idle",
  "running",
  "waiting",
  "closed",
  "error",
]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionStartedPayload = z.strictObject({
  agent: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().optional(),
});

export const SessionStatePayload = z.strictObject({
  state: SessionState,
  reason: z.string().optional(),
});

export const TurnStartedPayload = z.strictObject({
  turnId: TurnId,
  /** Model this turn runs on (engines with the models capability set it). */
  model: z.string().optional(),
});

export const TurnDeltaPayload = z.strictObject({
  turnId: TurnId,
  /** Which stream the chunk appends to — assistant answer vs. reasoning trace. */
  stream: z.enum(["text", "reasoning"]),
  delta: z.string(),
});

export const FileDiff = z.strictObject({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"]),
  add: z.int().min(0),
  del: z.int().min(0),
  patch: z.string().optional(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const CommitInfo = z.strictObject({
  hash: z.string().min(1),
  message: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      status: z.string(),
      add: z.int(),
      del: z.int(),
    }),
  ),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const ToolStartedPayload = z.strictObject({
  turnId: TurnId,
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export const ToolCompletedPayload = z.strictObject({
  turnId: TurnId,
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(["completed", "failed", "denied", "cancelled"]),
  output: z.string().optional(),
  diff: FileDiff.optional(),
  commit: CommitInfo.optional(),
});

export const RequestOpenedPayload = z.strictObject({
  turnId: TurnId,
  /** Stable id the client echoes in `request.respond`. */
  requestId: z.string().min(1),
  request: EngineRequest,
});

export const RequestResolvedPayload = z.strictObject({
  requestId: z.string().min(1),
  outcome: ApprovalOutcome,
  answer: z.string().optional(),
});

/**
 * The engine re-keyed a session's durable ref (some engines rotate the stored
 * session id when they compact history). `ref` is what a client stores for
 * resume/reattach — the transport `sessionId` itself stays stable across a
 * rotation, so this event is the only way to notice it.
 */
export const SessionRefChangedPayload = z.strictObject({
  ref: z.string().min(1),
  previousRef: z.string().min(1),
});

/** A steer that landed at a tool boundary inside the running turn. */
export const TurnSteeredPayload = z.strictObject({
  turnId: TurnId,
  text: z.string(),
});

export const TurnCompletedPayload = z.strictObject({
  turnId: TurnId,
  stopReason: StopReason,
  usage: Usage.optional(),
  error: z.string().optional(),
});

/** type -> payload map. The registry below is generated from this union. */
export const EngineEvent = z.discriminatedUnion("type", [
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("session.started"),
    payload: SessionStartedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("session.state"),
    payload: SessionStatePayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("turn.started"),
    payload: TurnStartedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("turn.delta"),
    payload: TurnDeltaPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("tool.started"),
    payload: ToolStartedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("tool.completed"),
    payload: ToolCompletedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("request.opened"),
    payload: RequestOpenedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("request.resolved"),
    payload: RequestResolvedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("session.ref.changed"),
    payload: SessionRefChangedPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("turn.steered"),
    payload: TurnSteeredPayload,
  }),
  z.strictObject({
    seq: Seq,
    sessionId: SessionId,
    type: z.literal("turn.completed"),
    payload: TurnCompletedPayload,
  }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
export type EngineEventType = EngineEvent["type"];

/** The notification method name that carries events on the wire. */
export const EVENT_METHOD = "event" as const;

/** Event name -> payload schema, derived from the union (single declaration). */
export const ENGINE_EVENT_TYPES = EngineEvent.options.map(
  (o) => o.shape.type.value,
);
