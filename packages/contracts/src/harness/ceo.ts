/**
 * The CEO brief (D-#778, D-#777). It is its own prompt section, rendered
 * only for a session that held the position at start, with its own
 * 2,000-char cap. It does not ride in the shared host policy: that text
 * is already at the cap, and a non-CEO session must not hear it.
 *
 * #746's spike kept a one-line brief in a throwaway profile. The loop is
 * the same job, said once: plan, hand off, check, move the next piece,
 * hand a stuck thread on, and write the owner a short update after each.
 * The CEO never approves or denies.
 */
export const CEO_BRIEF_MAX_CHARS = 2000;
export const CEO_BRIEF_MARKER = "[LilOS CEO brief v1]";

const CEO_BRIEF_BODY = [
  CEO_BRIEF_MARKER,
  "You hold the CEO position. Plan a goal into tickets with owners, hand each off, check a finished ticket's result, move the next one, hand a stuck thread to another agent, and post a short update after each. Answer routine questions. Ask the owner before hiring, firing, adding a folder, or spending money. Never approve or deny.",
  "- `ticket_create` writes a ticket. `ticket_assign` hands it to one owner and opens their thread. `ticket_read` checks a result.",
  "- `update_post` (only you) writes the owner a short note. kind is plan, finished, handed, stuck, or note. It does not ask.",
  "- A wake lists what changed. Act on every line, then post one update. Your own actions do not wake you.",
].join("\n");

export function renderCeoBrief(): string {
  if (CEO_BRIEF_BODY.length > CEO_BRIEF_MAX_CHARS) {
    throw new Error(
      `CEO brief is ${CEO_BRIEF_BODY.length} chars; the cap is ${CEO_BRIEF_MAX_CHARS}`,
    );
  }
  return CEO_BRIEF_BODY;
}
