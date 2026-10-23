import type { TurnVM } from "./types";

/* Who wrote what, so the author line (avatar + name) is drawn once per run of
   consecutive messages by the same author, the way iOS Messages groups
   bubbles, instead of on every turn. Pure so the grouping is testable. */

/** One message in reading order: `author` is a stable key for who wrote it,
    or absent for something with no author (a system note). */
export type Authored = { author?: string };

/** The key an agent's own messages carry. */
export const agentKey = (agentId: string) => `agent:${agentId}`;
const ME = "you";
const askerKey = (name: string) => `asker:${name}`;

/** Which messages open a run, i.e. get an author line. A different author, or
    a message with no author in between (a system note, which ends the run and
    never opens one), starts a new run. `named` is the author whose name sits
    right above the first message already (the thread header): a first run by
    them needs no line of its own. */
export function runStarts(
  messages: readonly Authored[],
  named?: string,
): boolean[] {
  let prev: string | undefined;
  return messages.map((m, i) => {
    const { author } = m;
    const starts = author !== undefined && author !== prev;
    prev = author;
    return starts && !(i === 0 && author === named);
  });
}

/** For each turn, whether its agent block opens a run (draw the author line).
    A turn is up to three messages in order: the prompt (yours, or the
    asker's quiet line), the agent's answer side, and your queued messages.
    Only the answer side has an author line to draw; the others are listed so
    they break runs. */
export function turnAuthorLines(
  turns: readonly TurnVM[],
  agentId: string,
  headerNamesAgent: boolean,
): boolean[] {
  const me = agentKey(agentId);
  const flat: (Authored & { turn: number; answer: boolean })[] = [];
  turns.forEach((t, turn) => {
    if (t.prompt) {
      flat.push({
        turn,
        answer: false,
        author: t.prompt.fromYou ? ME : askerKey(t.prompt.who),
      });
    }
    if (hasAnswerSide(t)) flat.push({ turn, answer: true, author: me });
    if (t.queued.length > 0) flat.push({ turn, answer: false, author: ME });
  });
  const starts = runStarts(flat, headerNamesAgent ? me : undefined);
  const lines = turns.map(() => false);
  flat.forEach((m, i) => {
    if (m.answer && starts[i]) lines[m.turn] = true;
  });
  return lines;
}

/** Whether a turn has anything of the agent's to show. */
export const hasAnswerSide = (t: TurnVM): boolean =>
  t.live ||
  t.steps.length > 0 ||
  !!t.answer ||
  !!t.summary ||
  t.attachments.length > 0;
