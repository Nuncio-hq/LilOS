import type { Approval } from "./types";

/* #264 — the one sentence an approval surface says above its command box.
   The wire's `description` is the engine's own "wants to run: <cmd>" echo
   (and the row's `reason` is the command itself once it's stripped), so a
   reason that merely contains the command would say it twice — once in the
   sentence and again in the box. Then the sentence is just
   "<employee> wants to run" and the box carries the command. A reason that
   says something else is a real why (prototype rows write one) and stays. */
export function approvalSentence(
  a: Pick<Approval, "employee" | "reason"> & { command?: string },
): string {
  if (a.command && a.reason.includes(a.command))
    return `${a.employee} wants to run`;
  return a.reason;
}
