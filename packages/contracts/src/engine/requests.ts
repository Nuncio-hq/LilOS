import { z } from "zod";

/**
 * Engine -> client asks. Per the parent feature (#5) the only request kinds
 * that cross the protocol are `approval` and `question`; secrets/sudo/vault
 * never leave an engine adapter. A request arrives inside a `request.opened`
 * event and is answered with the `request.respond` method, so it survives a
 * transport reconnect (replayed via `events.since` -> `openRequests`).
 */

export const ApprovalOption = z.enum(["once", "always", "deny"]);
export type ApprovalOption = z.infer<typeof ApprovalOption>;

export const ApprovalRequest = z.strictObject({
  kind: z.literal("approval"),
  /** What wants approval, e.g. the shell command or tool call. */
  command: z.string(),
  description: z.string().optional(),
  /** Options offered to the client, in display order. */
  options: z.array(ApprovalOption).min(1),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const QuestionOption = z.strictObject({
  /** Id the client returns as the answer. */
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionRequest = z.strictObject({
  kind: z.literal("question"),
  question: z.string().min(1),
  options: z.array(QuestionOption).optional(),
  /** True when free text is allowed besides the listed options. */
  freeText: z.boolean().optional(),
});
export type QuestionRequest = z.infer<typeof QuestionRequest>;

export const EngineRequest = z.discriminatedUnion("kind", [
  ApprovalRequest,
  QuestionRequest,
]);
export type EngineRequest = z.infer<typeof EngineRequest>;

/**
 * `request.respond` outcome. Approval -> `"once" | "always" | "deny" | "cancel"`;
 * question -> `"answer"` with `answer` set, or `"cancel"`. The engine validates
 * the outcome against the open request's kind.
 */
export const ApprovalOutcome = z.enum([
  "once",
  "always",
  "deny",
  "cancel",
  "answer",
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;

/** One open (unresolved) ask, replayed by `events.since`. */
export const OpenRequest = z.strictObject({
  requestId: z.string().min(1),
  turnId: z.string().min(1),
  request: EngineRequest,
  /** Seq of the `request.opened` event that raised it. */
  seq: z.int().min(1),
});
export type OpenRequest = z.infer<typeof OpenRequest>;
