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

/* Session management is in-process only (create/destroy/bindEngineSession
   on the harness's SurfacesServer): nothing reachable over the gateway port
   may pick a binding or an alias — there is no wire schema for it. */
