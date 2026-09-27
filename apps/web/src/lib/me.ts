import type { Human, HumanFn } from "@lilos/ui/types";

/* The signed-in human (this build is single-user). `USER_ID` is the author id
   the relay puts on that person's messages; every surface renders it as `ME` —
   sidebar footer, DM message rows, Focus captions — so the user reads as one
   identity, never the anonymous grey "You" (issue #80, AC-1). */
export const USER_ID = "user";

export const ME: Human = { name: "Oscar", color: "bg-blue-600" };

export const humanFor: HumanFn = (id) => (id === USER_ID ? ME : undefined);
