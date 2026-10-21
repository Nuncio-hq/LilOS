import { threadStatus } from "@lilos/client-runtime";
import type { ThreadSources } from "./threads";

/* Threads finished or failed since Monday, per employee. Status is
   `threadStatus` (client-runtime, D-#33) — the same derivation Threads
   uses, not a second one. Activity time is the summary's last message,
   else the thread's createdAt. Archived threads stay out, the same set
   Threads shows.

   Finished means the turn completed (`finishedSeq > 0`) and the thread is
   idle or unseen. A stopped turn is not a finished one (`turnStopped`),
   even when an earlier turn completed. Failure is already
   `threadStatus === "failed"`. Working and needs are in progress, not
   this week's tally.

   Stuck is left out: Conversation has no stuck mark. That lands with
   issue #772; until then the count is finished and failed only. */

export interface WeekCounts {
  finished: number;
  failed: number;
}

/** Monday 00:00 in the local timezone. "This week" runs from there. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const back = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

export function weekByAgent(src: ThreadSources): Map<string, WeekCounts> {
  const start = weekStart(src.now);
  const owners = new Map(src.channels.map((ch) => [ch.id, ch.employeeId]));
  const summaries = new Map(src.summaries.map((s) => [s.conversation.id, s]));
  const out = new Map<string, WeekCounts>();
  const bump = (id: string, key: "finished" | "failed") => {
    const row = out.get(id) ?? { finished: 0, failed: 0 };
    row[key] += 1;
    out.set(id, row);
  };
  for (const c of src.conversations) {
    if (c.archived) continue;
    const agentId = owners.get(c.channelId);
    if (!agentId) continue;
    const at = summaries.get(c.id)?.last.createdAt ?? c.createdAt;
    if (at < start) continue;
    const status = threadStatus(
      c,
      c.engineRef ? src.models[c.engineRef] : undefined,
      c.engineRef ? src.signals[c.engineRef] : undefined,
    );
    if (status === "failed") bump(agentId, "failed");
    else if (
      (status === "idle" || status === "unseen") &&
      c.finishedSeq > 0 &&
      !c.turnStopped
    )
      bump(agentId, "finished");
  }
  return out;
}
