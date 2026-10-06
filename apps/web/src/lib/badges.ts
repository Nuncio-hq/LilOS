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
import type { SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import type { EmpBadge } from "@lilos/ui/types";
import { computed, type ReadableAtom } from "nanostores";
import type { SessionSignal } from "./session-watch";

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
    for (const c of conversations) {
      if (c.channelId !== ch.id || !c.engineRef) continue;
      const m = models[c.engineRef];
      const sig = signals[c.engineRef];
      /* The broadcast-folded signal is always authoritative-or-equal:
         unwatched sessions get running/asks from it (or the row's `state`
         before the first seed), watched sessions get it reconciled off
         the synced model — so an attach/sync window never blinks a badge
         off. The model's live turn still wins when it says "waiting". */
      const asks = Math.max(
        m?.openRequests.length ?? 0,
        sig?.openRequests.size ?? 0,
      );
      // A turn parked on an open request reads "needs you", not "running"
      // (issue #71, AC-4).
      const run =
        (m?.live !== undefined && m.live.phase !== "waiting") ||
        (m?.live === undefined &&
          (sig?.running ?? c.state === "active") &&
          asks === 0);
      if (run) running += 1;
      approvals += asks;
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
