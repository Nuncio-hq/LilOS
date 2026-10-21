/**
 * Session-scoped brief for whoever holds the CEO position when the
 * thread's session starts (D-#778). It rides that session's host policy
 * only — not the employee's editable soul — so the agent page still shows
 * the persona they were hired with, and the next thread of someone who
 * no longer holds the position does not get it.
 *
 * #746's spike kept this brief in a throwaway profile. There is no
 * CEO-only tool list there: the CEO plans, splits the work, hands it
 * off, checks, and reports, and asks the owner before hiring, firing,
 * adding a folder, or spending money. The CEO never approves or denies.
 */
export const CEO_INSTRUCTIONS =
  "You hold the CEO position. Plan the work, split it, hand it off, check, and report. Answer routine questions. Ask the owner before hiring, firing, adding a folder, or spending money. Never approve or deny.";
