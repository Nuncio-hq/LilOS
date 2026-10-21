import type { Reply } from "../types";

/* Below this many replies every row always mounts — specs never build a
   thread this long, so their DOM contract is untouched. */
export const TURN_LAZY_AFTER = 24;

/* #570: a lazy thread's FIRST mount renders only its tail — rows older
   than an estimated `OPEN_TAIL_PX` of content start as stubs instead of
   mounting once and stubbing behind the observer (#430's measured path).
   ~3 ports of tail guarantees nothing in view starts held on any
   realistic window while the other ~95% of a 200-turn thread stays
   stubbed. */
export const OPEN_TAIL_PX = 3200;

/* Wrapped-line count at `cpl` chars/line — empty segments still cost a
   line box. Only needs to be close: a first-mount stub holds this until
   the row's real height is measured on its next hold (#537). */
const estLines = (text: string, cpl: number) =>
  text
    .split("\n")
    .reduce((a, s) => a + Math.max(1, Math.ceil(s.length / cpl)), 0);

/** Estimated px height for a never-mounted row — the #570 first-mount
    stub's stand-in. Column width decides wrap (`frame`), card kinds add
    their chrome. Never smaller than a real row; overshoot is safer than
    collapse (the pin lands at the bottom regardless). */
export function estTurnHeight(
  r: Reply,
  agent: boolean,
  frame: "panel" | "focus",
): number {
  const cpl = frame === "focus" ? 86 : 50;
  if (!agent) {
    /* UserTurn: bubble padding + wrapped text + the time line + chips. */
    return 46 + estLines(r.text, cpl) * 23 + (r.attachments?.length ? 34 : 0);
  }
  /* AgentTurn: who row + the one work fold line + body + cards + footer. */
  let h = 60 + estLines(r.text, cpl) * 24;
  if (r.reasoning !== undefined || r.steps?.length) h += 36;
  if (r.plan) h += 40 + r.plan.steps.length * 22;
  if (r.approval || r.question) h += 110;
  if (r.startProposal) h += 56;
  if (r.subagents?.length) h += 30;
  if (r.attachments?.length) h += 34;
  if (r.error) h += 30;
  return h;
}

/** First row index that mounts real on open: walk back from the newest
    reply until `px` of estimated height is covered. */
export function openTailStart(
  heights: readonly number[],
  px = OPEN_TAIL_PX,
): number {
  let acc = 0;
  for (let i = heights.length - 1; i >= 0; i--) {
    acc += heights[i];
    if (acc >= px) return i;
  }
  return 0;
}
