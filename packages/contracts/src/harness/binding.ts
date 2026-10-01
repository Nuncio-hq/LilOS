import { z } from "zod";

/**
 * What a gateway session is bound to (issue #337 AC-3): the employee it runs
 * as, the channel its thread lives in, and the conversation `thread_*` tools
 * address. The harness declares the binding when it creates the session —
 * a tool call resolves it from the session record, never from ids the agent
 * passes.
 */
export const SessionBinding = z.strictObject({
  /** Employee record the session runs as. */
  employeeId: z.string().min(1),
  /** Channel the thread lives in (the employee's DM channel). */
  channelId: z.string().min(1),
  /** The conversation this session's `thread_*` tools read and post to. */
  conversationId: z.string().min(1),
});
export type SessionBinding = z.infer<typeof SessionBinding>;

/** `POST /surfaces/sessions` — creating one gateway session. */
export const CreateGatewaySession = z.strictObject({
  /** Working folder the session's terminal and browser start in. */
  cwd: z.string().min(1).optional(),
  binding: SessionBinding.optional(),
  /**
   * The engine's own session id (e.g. a timestamped id like
   * `20261001_124426_cb5b3e`), recorded as an alias so engine-side callers
   * carrying it resolve to this scope. Can also be bound later via
   * POST /surfaces/sessions/<id>/engine.
   */
  engineSessionId: z.string().min(1).optional(),
});
export type CreateGatewaySession = z.infer<typeof CreateGatewaySession>;

/** `POST /surfaces/sessions/<id>/engine` — register an engine-session alias. */
export const BindEngineSession = z.strictObject({
  engineSessionId: z.string().min(1),
});
export type BindEngineSession = z.infer<typeof BindEngineSession>;
