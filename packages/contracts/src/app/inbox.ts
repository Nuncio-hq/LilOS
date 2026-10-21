import { z } from "zod";
import { AuthorKind } from "./domain.js";

/**
 * What the company told the owner (D-#777). Distinct from a ticket's own
 * update list and from the software-update feed. `handed` is the record
 * form of "handed off". The author is the CEO's employee id, or LilOS
 * (`authorKind: "system"`, no id) for a note the app wrote itself.
 */
export const CompanyUpdateKind = z.enum([
  "plan",
  "finished",
  "handed",
  "stuck",
  "note",
]);
export type CompanyUpdateKind = z.infer<typeof CompanyUpdateKind>;

export const CompanyUpdate = z.object({
  id: z.string().min(1),
  kind: CompanyUpdateKind,
  text: z.string().min(1),
  ticketId: z.string().min(1).optional(),
  goalId: z.string().min(1).optional(),
  authorKind: AuthorKind,
  authorId: z.string().min(1).optional(),
  createdAt: z.number().int(),
});
export type CompanyUpdate = z.infer<typeof CompanyUpdate>;

export const UpdatesListParams = z.object({}).strict();
export type UpdatesListParams = z.infer<typeof UpdatesListParams>;
export const UpdatesListResult = z.object({
  updates: z.array(CompanyUpdate),
});
export type UpdatesListResult = z.infer<typeof UpdatesListResult>;

/**
 * Host-only. The tool does not carry `authorKind` or `authorId`: the
 * harness stamps the bound employee. A system note omits `authorId`.
 */
export const UpdatesPostParams = z
  .object({
    kind: CompanyUpdateKind,
    text: z.string().trim().min(1).max(2000),
    ticketId: z.string().min(1).optional(),
    goalId: z.string().min(1).optional(),
    authorKind: z.enum(["employee", "system"]).optional(),
    authorId: z.string().min(1).optional(),
  })
  .strict();
export type UpdatesPostParams = z.infer<typeof UpdatesPostParams>;

export const UpdatesPostResult = z.object({ update: CompanyUpdate });
export type UpdatesPostResult = z.infer<typeof UpdatesPostResult>;

export const UpdateUpsertedEvent = z.object({ update: CompanyUpdate });
export type UpdateUpsertedEvent = z.infer<typeof UpdateUpsertedEvent>;
