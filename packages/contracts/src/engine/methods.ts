import { z } from "zod";
import {
  AgentsCreateParams,
  AgentsCreateResult,
  AgentsDescribeParams,
  AgentsDescribeResult,
  AgentsListParams,
  AgentsListResult,
  AgentsUpdateParams,
  AgentsUpdateResult,
} from "./agents.js";
import { Capability } from "./capabilities.js";
import { ContentBlock } from "./content.js";
import {
  EngineEvent,
  JobStatus,
  SessionState,
  StopReason,
  Usage,
} from "./events.js";
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
  /** Opaque model id (may contain `/`) — never a joined `provider/model`. */
  model: z.string().optional(),
  /** Provider slug when the engine is multi-provider (with `model`). */
  provider: z.string().optional(),
  /** Session reasoning-effort level, when the picker pinned one. */
  effort: z.string().optional(),
  /** Fast/priority tier the session should run on. */
  fast: z.boolean().optional(),
  /** ACP-shaped MCP server list; the LilOS MCP server rides in here (#23). */
  mcpServers: z.array(McpServer).optional(),
});
export type SessionStartParams = z.infer<typeof SessionStartParams>;

export const SessionStartResult = z.object({
  sessionId: z.string().min(1),
  /**
   * The engine's own session id inside its engine, when it has one
   * (#339 — the engine's stored session key). The harness registers it as a
   * gateway alias so an in-process engine plugin that only knows its own
   * id resolves the same session scope.
   */
  engineSessionId: z.string().min(1).optional(),
});
export type SessionStartResult = z.infer<typeof SessionStartResult>;

// ── prompt ──────────────────────────────────────────────────────────────────
export const PromptParams = z.strictObject({
  sessionId: SessionId,
  /** ACP ContentBlock list: text always allowed, image under image_prompt. */
  content: z.array(ContentBlock).min(1),
  /**
   * Opaque client tag echoed back on the turn's `turn.started` event — how a
   * replaying client proves which of its messages the turn consumed (the
   * harness passes the relay message id).
   */
  ref: z.string().min(1).optional(),
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
  /** The rest of the session's pick: provider slug, effort level, fast tier. */
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  /** Engine-set session title (#137): present once the engine has persisted
      one — replays after an engine restart land the same title. */
  title: z.string().optional(),
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
  /* Client tag echo'd on `turn.started` like `prompt.ref` — a steer that
     outlives its turn is pumped as the next prompt, and the link back to
     the relay message must survive that requeue (#134 rewind needs it). */
  ref: z.string().min(1).optional(),
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

// ── session.setTitle / session.setHidden (capability: session_meta) ────────
export const SessionSetTitleParams = z.strictObject({
  sessionId: SessionId,
  title: z.string().min(1),
});
export type SessionSetTitleParams = z.infer<typeof SessionSetTitleParams>;
export const SessionSetTitleResult = z.object({ title: z.string() });
export type SessionSetTitleResult = z.infer<typeof SessionSetTitleResult>;

/**
 * "Hidden" = out of the engine's default session list but still resumable —
 * the engine-side counterpart of the app's `archived` flag.
 */
export const SessionSetHiddenParams = z.strictObject({
  sessionId: SessionId,
  hidden: z.boolean(),
});
export type SessionSetHiddenParams = z.infer<typeof SessionSetHiddenParams>;
export const SessionSetHiddenResult = z.object({ hidden: z.boolean() });
export type SessionSetHiddenResult = z.infer<typeof SessionSetHiddenResult>;

// ── session.rewind (capability: rewind) ─────────────────────────────────────
/**
 * Rewind the session's conversation to just before a user turn (issue #134):
 * `toTurn` counts how many leading user turns to KEEP — the engine drops the
 * rest of the turns from its context so the next prompt continues from the
 * earlier state. File restoration is NOT part of this method: the harness
 * owns folder checkpoints, so rewind works the same on engines that never
 * touch the filesystem (and on transports without history rewind, e.g. ACP
 * today, the capability is simply not declared).
 */
export const SessionRewindParams = z.strictObject({
  sessionId: SessionId,
  /** Number of leading user turns to keep; the rest are forgotten. */
  toTurn: z.int().min(0),
});
export type SessionRewindParams = z.infer<typeof SessionRewindParams>;
export const SessionRewindResult = z.object({
  /** User turns the engine dropped. */
  removed: z.int().min(0),
});
export type SessionRewindResult = z.infer<typeof SessionRewindResult>;

// ── jobs.list / jobs.stop (capability: background_jobs, #179) ───────────────
/** One row of `jobs.list` — the engine-owned truth a client re-reads after
    a reconnect (job.* events are the live stream, this is the snapshot). */
export const Job = z.object({
  jobId: z.string().min(1),
  command: z.string().min(1),
  status: JobStatus,
  startedAt: z.int().min(0).optional(),
  uptimeSeconds: z.number().min(0).optional(),
  /** Ms epoch the job stopped running — a finished job's uptime freezes here. */
  endedAt: z.int().min(0).optional(),
  exitCode: z.int().optional(),
  url: z.string().min(1).optional(),
  by: z.string().min(1).optional(),
  /** Rolling output tail (same contract as job.output). */
  tail: z.string().optional(),
});
export type Job = z.infer<typeof Job>;

export const JobsListParams = z.strictObject({ sessionId: SessionId });
export type JobsListParams = z.infer<typeof JobsListParams>;
export const JobsListResult = z.object({ jobs: z.array(Job) });
export type JobsListResult = z.infer<typeof JobsListResult>;

export const JobsStopParams = z.strictObject({
  sessionId: SessionId,
  jobId: z.string().min(1),
});
export type JobsStopParams = z.infer<typeof JobsStopParams>;
export const JobsStopResult = z.object({
  /** True when a running process was signalled; false = already gone. */
  stopped: z.boolean(),
});
export type JobsStopResult = z.infer<typeof JobsStopResult>;

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
  "agents.update": {
    params: AgentsUpdateParams,
    result: AgentsUpdateResult,
    doc: "Write persona fields back to the agent (soul, default model, name, description — the capability's `detail.updatable` lists which). New sessions started after the call use the update; running sessions keep the persona/model they began with.",
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
  "session.setTitle": {
    params: SessionSetTitleParams,
    result: SessionSetTitleResult,
    doc: "Set the engine session's display title — the harness mirrors the app's rename so the engine's own lists stay consistent.",
    capability: "session_meta",
  },
  "session.setHidden": {
    params: SessionSetHiddenParams,
    result: SessionSetHiddenResult,
    doc: "Move the engine session out of / back into its default list — the engine-side counterpart of archive/unarchive.",
    capability: "session_meta",
  },
  "session.rewind": {
    params: SessionRewindParams,
    result: SessionRewindResult,
    doc: "Drop all user turns after `toTurn` from the session's context (issue #134). Refuses INVALID_STATE while a turn runs. Engines on transports without history rewind (ACP today) don't declare the capability.",
    capability: "rewind",
  },
  "jobs.list": {
    params: JobsListParams,
    result: JobsListResult,
    doc: "List the engine-owned background processes of a session — the truth list a client re-reads after reconnect (job.* events are the live stream).",
    capability: "background_jobs",
  },
  "jobs.stop": {
    params: JobsStopParams,
    result: JobsStopResult,
    doc: "Stop a background process by the jobId from job.started / jobs.list. The stop lands as a job.exited event with status stopped.",
    capability: "background_jobs",
  },
};
export type EngineMethodName = keyof typeof ENGINE_METHODS;
