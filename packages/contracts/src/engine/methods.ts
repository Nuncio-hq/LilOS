import { z } from "zod";
import {
  AgentsCreateParams,
  AgentsCreateResult,
  AgentsDescribeParams,
  AgentsDescribeResult,
  AgentsListParams,
  AgentsListResult,
} from "./agents.js";
import { Capability } from "./capabilities.js";
import { ContentBlock } from "./content.js";
import { EngineEvent, SessionState, StopReason, Usage } from "./events.js";
import { McpServer } from "./mcp.js";
import {
  ModelsListParams,
  ModelsListResult,
  SessionSetModelParams,
  SessionSetModelResult,
} from "./models.js";
import { ENGINE_PROTOCOL } from "./protocol.js";
import { ApprovalOutcome, OpenRequest } from "./requests.js";

/**
 * The engine method map — the single declaration of the wire (method name ->
 * params/result schema). `packages/contracts/scripts/gen-schemas.ts`
 * renders this table to JSON Schema; engines and the conformance suite read it
 * here. Adding a method is: schema pair + one entry (+ a capability when it is
 * not core). Params are strict: unknown keys are the caller's bug and answer
 * INVALID_PARAMS (-32602).
 */

const SessionId = z.string().min(1);

// ── describe ────────────────────────────────────────────────────────────────
export const DescribeParams = z.strictObject({});
export const DescribeResult = z.object({
  /** Engine identity, e.g. "engine-fake". Never branch on this in the app. */
  name: z.string().min(1),
  version: z.string().min(1),
  protocol: z.strictObject({
    name: z.literal(ENGINE_PROTOCOL.name),
    version: z.literal(ENGINE_PROTOCOL.version),
  }),
  capabilities: z.array(Capability),
});
export type DescribeResult = z.infer<typeof DescribeResult>;

// ── session.start ───────────────────────────────────────────────────────────
export const SessionStartParams = z.strictObject({
  /** Engine-side agent/profile id the session runs as. */
  agent: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().optional(),
  /** ACP-shaped MCP server list; the LilOS MCP server rides in here (#23). */
  mcpServers: z.array(McpServer).optional(),
});
export type SessionStartParams = z.infer<typeof SessionStartParams>;

export const SessionStartResult = z.object({ sessionId: z.string().min(1) });
export type SessionStartResult = z.infer<typeof SessionStartResult>;

// ── prompt ──────────────────────────────────────────────────────────────────
export const PromptParams = z.strictObject({
  sessionId: SessionId,
  /** ACP ContentBlock list: text always allowed, image under image_prompt. */
  content: z.array(ContentBlock).min(1),
});
export type PromptParams = z.infer<typeof PromptParams>;

/**
 * `prompt` resolves when the turn finishes; progress streams as `event`
 * notifications meanwhile (`turn.*`, `tool.*`, `request.*`).
 */
export const PromptResult = z.object({
  turnId: z.string().min(1),
  stopReason: StopReason,
  usage: Usage.optional(),
});
export type PromptResult = z.infer<typeof PromptResult>;

// ── interrupt ───────────────────────────────────────────────────────────────
export const InterruptParams = z.strictObject({ sessionId: SessionId });
export type InterruptParams = z.infer<typeof InterruptParams>;
export const InterruptResult = z.object({
  /** False when the session was idle — an interrupt of nothing is not an error. */
  interrupted: z.boolean(),
});
export type InterruptResult = z.infer<typeof InterruptResult>;

// ── request.respond ─────────────────────────────────────────────────────────
export const RequestRespondParams = z.strictObject({
  sessionId: SessionId,
  requestId: z.string().min(1),
  outcome: ApprovalOutcome,
  /** Required when outcome is "answer" (a `question` request). */
  answer: z.string().optional(),
});
export type RequestRespondParams = z.infer<typeof RequestRespondParams>;

export const RequestRespondResult = z.object({ accepted: z.literal(true) });
export type RequestRespondResult = z.infer<typeof RequestRespondResult>;

// ── events.since ────────────────────────────────────────────────────────────
export const EventsSinceParams = z.strictObject({
  sessionId: SessionId,
  /** Replay watermark: events with seq > after are returned. */
  after: z.int().min(0),
});
export type EventsSinceParams = z.infer<typeof EventsSinceParams>;

/** What a (re)connecting client needs to re-render one session. */
export const SessionSnapshot = z.object({
  sessionId: SessionId,
  state: SessionState,
  turn: z
    .strictObject({
      turnId: z.string().min(1),
      phase: z.enum(["reasoning", "tools", "text", "waiting"]),
    })
    .optional(),
  usage: Usage.optional(),
  /** Model the session is currently pinned to, when the engine tracks it. */
  model: z.string().optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const EventsSinceResult = z.object({
  events: z.array(EngineEvent),
  latestSeq: z.int().min(0),
  /** True when the replay buffer dropped events <= after: refetch, don't patch. */
  truncated: z.boolean(),
  /** Asks still awaiting `request.respond`. */
  openRequests: z.array(OpenRequest),
  snapshot: SessionSnapshot,
});
export type EventsSinceResult = z.infer<typeof EventsSinceResult>;

// ── session.stop ────────────────────────────────────────────────────────────
export const SessionStopParams = z.strictObject({ sessionId: SessionId });
export type SessionStopParams = z.infer<typeof SessionStopParams>;
export const SessionStopResult = z.object({ stopped: z.boolean() });
export type SessionStopResult = z.infer<typeof SessionStopResult>;

// ── session.steer (capability: steer) ───────────────────────────────────────
export const SessionSteerParams = z.strictObject({
  sessionId: SessionId,
  text: z.string().min(1),
});
export type SessionSteerParams = z.infer<typeof SessionSteerParams>;
export const SessionSteerResult = z.object({
  /**
   * "steered": accepted — lands at the next tool boundary, or becomes the
   * next turn's input when the turn ends first (a steer is never lost).
   * "not_running": no turn is running and the text was NOT consumed — the
   * client sends it as `prompt` instead.
   */
  status: z.enum(["steered", "not_running"]),
});
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// ── the table ────────────────────────────────────────────────────────────────
export interface EngineMethodContract {
  params: z.ZodType;
  result: z.ZodType;
  doc: string;
  /** Set when the method only exists under a declared capability. */
  capability?: string;
}

export const ENGINE_METHODS: Record<string, EngineMethodContract> = {
  describe: {
    params: DescribeParams,
    result: DescribeResult,
    doc: "Handshake: protocol name/version plus the engine's capability descriptors.",
  },
  "session.start": {
    params: SessionStartParams,
    result: SessionStartResult,
    doc: "Create a session. mcpServers is the ACP shape; the LilOS MCP server rides in it.",
  },
  prompt: {
    params: PromptParams,
    result: PromptResult,
    doc: "Send one user turn; resolves with the stop reason when the turn ends.",
  },
  interrupt: {
    params: InterruptParams,
    result: InterruptResult,
    doc: "Abort the running turn; the pending prompt resolves with stopReason cancelled.",
  },
  "request.respond": {
    params: RequestRespondParams,
    result: RequestRespondResult,
    doc: "Answer an open approval/question from a request.opened event.",
  },
  "events.since": {
    params: EventsSinceParams,
    result: EventsSinceResult,
    doc: "Replay events after a seq watermark; returns a snapshot plus open requests.",
  },
  "session.stop": {
    params: SessionStopParams,
    result: SessionStopResult,
    doc: "Close the session; its event log stays replayable.",
  },
  "session.steer": {
    params: SessionSteerParams,
    result: SessionSteerResult,
    doc: "Inject text into the running turn: lands at the next tool boundary as turn.steered, or becomes the next turn's input when the turn ends first. not_running = nothing was consumed; send prompt instead.",
    capability: "steer",
  },
  "agents.list": {
    params: AgentsListParams,
    result: AgentsListResult,
    doc: "List the engine's hireable agents (profiles) for the hire dialog.",
    capability: "agents",
  },
  "agents.describe": {
    params: AgentsDescribeParams,
    result: AgentsDescribeResult,
    doc: "One agent's full descriptor, including its persona text.",
    capability: "agents",
  },
  "agents.create": {
    params: AgentsCreateParams,
    result: AgentsCreateResult,
    doc: "Register a new agent profile on the engine. No delete exists by design.",
    capability: "agents",
  },
  "models.list": {
    params: ModelsListParams,
    result: ModelsListResult,
    doc: "List the engine's selectable models for the model picker.",
    capability: "models",
  },
  "session.setModel": {
    params: SessionSetModelParams,
    result: SessionSetModelResult,
    doc: "Pin a model on a session; the next turn uses it (see turn.started.model).",
    capability: "models",
  },
};
export type EngineMethodName = keyof typeof ENGINE_METHODS;
