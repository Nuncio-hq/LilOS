import type { ApprovalOutcome } from "@lilos/contracts/engine";

/* Resolved-ask labels carry the signed-in human's name — computed per render
   so a settings change lands without a reload (#118). */
export const outcomeLabel = (o: ApprovalOutcome, name: string): string => {
  switch (o) {
    case "once":
      return `Allowed once by ${name}`;
    /* #106: "This thread" — the grant lives until the thread's engine
       session ends; only this thread stopped asking. */
    case "session":
      return `Allowed this thread by ${name}`;
    case "always":
      return "Always allowed here";
    /* #884: a deny is a normal answer, not a failure — "You said no",
       never "Denied by …". */
    case "deny":
      return "You said no";
    case "cancel":
      return "Cancelled";
    case "answer":
      return "Answered";
    /* #180: plan requests resolve to these; labels match the card wording. */
    case "approve":
      return `Approved by ${name}`;
    case "reject":
      return `Rejected by ${name}`;
    case "change":
      return `Change requested by ${name}`;
  }
};

export function outcomeFromLabel(v: string): ApprovalOutcome {
  /* "Denied" covers pre-#884 stored labels. */
  if (v === "You said no" || v.startsWith("Denied")) return "deny";
  if (v.startsWith("Always")) return "always";
  /* #106: the card's resolved label for the thread-scoped grant — reads
     both the current wording and pre-#582 stored rows. */
  if (v.startsWith("Allowed this ")) return "session";
  if (v.startsWith("Cancelled")) return "cancel";
  if (v.startsWith("Answered")) return "answer";
  return "once";
}
