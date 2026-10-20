/**
 * Issue #32 — AC-3: per-employee sidebar badges derived from live engine
 * session models. Approvals waiting on the user and running turns are counted
 * per employee across that employee's DM conversations; the sidebar renders
 * approvals first (amber, priority) then running (blue).
 *
 * #572: unwatched sessions have no model — the broadcast-folded signal (or
 * the relay row's `state`) answers instead, so a background badge survives
 * the scoped replay.
 */
import { liveState, type SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import type { EmpBadge } from "@lilos/ui/types";
import { computed, type ReadableAtom } from "nanostores";
import type { SessionSignal } from "./session-watch";

/* One conversation's running/needs-you state: the ⌘K switcher's session
   badges read the same fold the per-employee counts do, and that fold lives
   once in client-runtime (`liveState`, D-#33). */
export function sessionBadge(
  c: Conversation,
  models: Record<string, SessionModel>,
  signals: Record<string, SessionSignal>,
): { running: boolean; needsYou: boolean; asks: number } {
  const ref = c.engineRef ?? "";
  const { running, asks } = liveState(c, models[ref], signals[ref]);
  return { running, needsYou: asks > 0, asks };
}

export function employeeBadges(
  channels: readonly AppChannel[],
  conversations: readonly Conversation[],
  models: Record<string, SessionModel>,
  signals: Record<string, SessionSignal>,
): Record<string, EmpBadge> {
  const out: Record<string, EmpBadge> = {};
  for (const ch of channels) {
    if (ch.kind !== "dm") continue;
    let running = 0;
    let approvals = 0;
    /* #563: any of this DM's threads finished past the user's read
       watermark dots the employee — cleared by opening the thread
       (`conversations.markRead`), on every device at once. */
    let unseen = false;
    for (const c of conversations) {
      if (c.channelId !== ch.id) continue;
      /* Archived threads don't dot the employee — same rule the phone's
         home row applies. */
      if (!c.archived && c.finishedSeq > c.readSeq) unseen = true;
      if (!c.engineRef) continue;
      const b = sessionBadge(c, models, signals);
      if (b.running) running += 1;
      approvals += b.asks;
    }
    if (running || approvals || unseen) {
      out[ch.employeeId] = {
        running: running || undefined,
        approvals: approvals || undefined,
        unseen: unseen || undefined,
      };
    }
  }
  return out;
}

/* #427: a badge map only differs when a count moved — keeping the previous
   record means `computed` never notifies for a count-neutral source change
   (a streamed word rebuilds `sessionModels` constantly). */
const sameBadges = (
  a: Record<string, EmpBadge>,
  b: Record<string, EmpBadge>,
): boolean => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((k) => {
      const x = a[k];
      const y = b[k];
      return (
        y !== undefined &&
        x.running === y.running &&
        x.approvals === y.approvals &&
        x.unseen === y.unseen
      );
    })
  );
};

/**
 * #427: the badge map as a computed store — its sources update on every
 * engine event, but its value only when a running/approvals count actually
 * moves, so the sidebar stops re-rendering on every streamed word.
 */
export function badgeStore(
  channels: ReadableAtom<readonly AppChannel[]>,
  conversations: ReadableAtom<readonly Conversation[]>,
  models: ReadableAtom<Record<string, SessionModel>>,
  signals: ReadableAtom<Record<string, SessionSignal>>,
): ReadableAtom<Record<string, EmpBadge>> {
  let prev: Record<string, EmpBadge> = {};
  return computed(
    [channels, conversations, models, signals],
    (ch, cv, m, sig) => {
      const next = employeeBadges(ch, cv, m, sig);
      if (sameBadges(prev, next)) return prev;
      prev = next;
      return next;
    },
  );
}
