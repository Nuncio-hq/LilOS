import { z } from "zod";

export const HostUserParams = z.strictObject({});

/** The OS account the app runs under — prefill source for identity (#118). */
export const HostUserResult = z.object({
  /** OS login (e.g. `oscar`) — always present. */
  username: z.string(),
  /** The account's full/display name when the OS exposes one; else null. */
  fullName: z.string().nullable(),
  /** The account's home dir — lets clients expand stored `~/…` paths (#134). */
  home: z.string(),
});
export type HostUserResult = z.infer<typeof HostUserResult>;
