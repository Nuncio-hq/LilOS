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

/* Lines break only between arguments, and a flag stays with its value
   ("--env dev"): non-breaking hyphens + a no-break space after a flag. */
export function keepFlags(command: string) {
  return command
    .replace(/(^|\s)(-{1,2}[\w-]+) (?=[^-\s])/g, "$1$2 ")
    .replace(/-/g, "‑");
}

/** #652: the accessory's one-line ask description — the same human
    sentence the thread card leads with (never a bare `patch {…}` tool
    call), with the command after it. Offline the "Last known" marker
    leads so truncation can't cut it away. */
export function accessoryWhat(
  a: Pick<Approval, "employee" | "reason" | "lastKnown"> & {
    command?: string;
    file?: { name: string };
  },
): string {
  const what = a.command
    ? `${approvalSentence(a)} · ${keepFlags(a.command)}`
    : a.file
      ? `${approvalSentence(a)} · ${a.file.name}`
      : approvalSentence(a);
  return `${a.lastKnown ? "Last known · " : ""}${what}`;
}
