/**
 * Issue #32 — AC-3: per-employee sidebar badges derived from live engine
 * session models. Approvals waiting on the user and running turns are counted
 * per employee across that employee's DM conversations; the sidebar renders
 * approvals first (amber, priority) then running (blue).
 */
import type { SessionModel } from "@lilos/client-runtime";
import type { AppChannel, Conversation } from "@lilos/contracts/app";
import type { EmpBadge } from "@lilos/ui/types";

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
