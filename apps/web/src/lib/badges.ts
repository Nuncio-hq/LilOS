/**
 * Issue #32 — AC-3: per-employee sidebar badges derived from live engine
 * session models. Approvals waiting on the user and running turns are counted
 * per employee across that employee's DM conversations; the sidebar renders
 * approvals first (amber, priority) then running (blue).
 */
import type { SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import type { EmpBadge } from "@lilos/ui/types";
import { computed, type ReadableAtom } from "nanostores";

export function employeeBadges(
  channels: readonly AppChannel[],
  conversations: readonly Conversation[],
  models: Record<string, SessionModel>,
): Record<string, EmpBadge> {
  const out: Record<string, EmpBadge> = {};
  for (const ch of channels) {
    if (ch.kind !== "dm") continue;
    let running = 0;
    let approvals = 0;
    for (const c of conversations) {
      if (c.channelId !== ch.id || !c.engineRef) continue;
      const m = models[c.engineRef];
      if (!m) continue;
      // A turn parked on an open request reads "needs you", not "running"
      // (issue #71, AC-4).
      if (m.live && m.live.phase !== "waiting") running += 1;
      approvals += m.openRequests.length;
    }
    if (running || approvals) {
      out[ch.employeeId] = {
        running: running || undefined,
        approvals: approvals || undefined,
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
        x.approvals === y.approvals
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
): ReadableAtom<Record<string, EmpBadge>> {
  let prev: Record<string, EmpBadge> = {};
  return computed([channels, conversations, models], (ch, cv, m) => {
    const next = employeeBadges(ch, cv, m);
    if (sameBadges(prev, next)) return prev;
    prev = next;
    return next;
  });
}
