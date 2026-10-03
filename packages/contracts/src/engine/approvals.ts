import { z } from "zod";

/**
 * Approvals surface (issue #106).
 *
 * Two pieces of protocol cross here:
 * - `ConversationAccess` — the per-conversation level LilOS stores on the
 *   conversation and stamps into `session.start`: `"ask"` stops at every
 *   approval request, `"full"` has the harness answer them itself
 *   (engine-neutral). Engines may take it as a hint (WS yolo, ACP
 *   `session/set_mode`) but correctness never depends on that.
 * - `ApprovalPolicy` — the engine's global approval policy
 *   (the engine's own `approvals.mode`-style setting), read/written through
 *   `approvals.setPolicy` under the `approval_policy` capability.
 */

/** Per-conversation access level carried on session.start / session.setAccess. */
export const ConversationAccess = z.enum(["ask", "full"]);
export type ConversationAccess = z.infer<typeof ConversationAccess>;

/** The engine's global approval policy — the engine's own mode setting. */
export const ApprovalPolicy = z.enum(["smart", "manual", "off"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

// ── approvals.setPolicy ─────────────────────────────────────────────────────
export const ApprovalsSetPolicyParams = z.strictObject({
  policy: ApprovalPolicy,
});
export type ApprovalsSetPolicyParams = z.infer<typeof ApprovalsSetPolicyParams>;
export const ApprovalsSetPolicyResult = z.object({
  policy: ApprovalPolicy,
});
export type ApprovalsSetPolicyResult = z.infer<typeof ApprovalsSetPolicyResult>;

// ── session.setAccess ───────────────────────────────────────────────────────
export const SessionSetAccessParams = z.strictObject({
  sessionId: z.string().min(1),
  access: ConversationAccess,
});
export type SessionSetAccessParams = z.infer<typeof SessionSetAccessParams>;
export const SessionSetAccessResult = z.object({
  access: ConversationAccess,
});
export type SessionSetAccessResult = z.infer<typeof SessionSetAccessResult>;
