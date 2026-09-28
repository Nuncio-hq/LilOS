import { z } from "zod";

export const HostUserParams = z.strictObject({});

/** The OS account the app runs under — prefill source for identity (#118). */
export const HostUserResult = z.object({
  /** OS login (e.g. `oscar`) — always present. */
  username: z.string(),
  /** The account's full/display name when the OS exposes one; else null. */
  fullName: z.string().nullable(),
});
export type HostUserResult = z.infer<typeof HostUserResult>;
