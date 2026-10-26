import {
  agentNameOf,
  snoozeBack,
  type V3Ask,
  type V3DataActions,
  type V3Thread,
} from "@lilos/ui";
import { type Engine, threadPatch } from "./context";

/* Park actions (#862): pin keeps a thread on top; snooze puts it to
   sleep — it keeps working underneath, on its folded shelf, until the wake
   time, a raised hand (needs you / stuck / failed — the model's `snoozed`
   wakes it), or your next message, whichever is first; Wake now ends it;
   Auto-settle off keeps one thread from parking itself. Settle and
   Un-settle stay on the wire's archiveThread in chats.ts. All mock — the
   relay slice syncs these fields across your machines. */

/* The ask a snoozed working thread can still raise (the demo for "it wakes
   when it needs you"): what its agent would have asked once it got there,
   per thread — it fires a few seconds after the snooze, like an agent
   reaching a step it cannot decide alone. Absent = the thread just sleeps
   to its wake time. */
const SNOOZE_ASKS: Record<
  string,
  Omit<V3Ask, "id" | "threadId" | "waiting" | "at">
> = {
  "t-hb12-ceo": {
    ticketId: "HB-12",
    from: "ceo",
    kind: "approval",
    title: "OK to ship variant B to half of new users?",
    ask: "Both variants pass on device. Ship B to 50% of new installs now?",
    why: "Copy B reads better in review and the paywall test is green. Rolling out while traffic is high gets a read this week.",
    ifYes: "Variant B goes to half of new users tonight; results on Friday.",
    ifNo: "Nothing ships; the test stays a review.",
    fallback: { at: "18:00", does: "holds the rollout" },
  },
};

/* The pending early wake per snoozed thread; a Wake now — or your message —
   before it fires cancels it. */
const early = new Map<string, number>();

/** A message from you or a Wake now beats the scripted ask. */
export function clearEarlyWake(threadId: string) {
  window.clearTimeout(early.get(threadId));
  early.delete(threadId);
}

export function parkActions({ setData, getData, toast }: Engine): Pick<
  V3DataActions,
  "pinThread" | "snoozeThread" | "wakeThread" | "setAutoSettle"
> {
  /* The park fields live wherever the thread does, live or on the shelf. */
  const patch = (id: string, patch: Partial<V3Thread>) =>
    setData((d) => ({
      ...d,
      threads: threadPatch(d, (t) => t.id === id, patch),
      archivedThreads: d.archivedThreads?.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    }));

  return {
    pinThread: (threadId, pinned) => {
      patch(threadId, { pinnedAt: pinned ? Date.now() : undefined });
      toast(pinned ? "Pinned · it stays on top" : "Unpinned");
    },
    snoozeThread: (threadId, until) => {
      patch(threadId, { snoozedUntil: until });
      toast(`Snoozed · ${snoozeBack(until)} — it keeps working underneath`);
      /* The early wake: a snoozed thread that is working can still reach a
         step it cannot decide alone — its hand goes up, and raised hands
         wake it (the model's `snoozed` never holds needs/stuck/failed). */
      const th = getData().threads.find((t) => t.id === threadId);
      const script = SNOOZE_ASKS[threadId];
      if (!th || !script) return;
      early.set(
        threadId,
        window.setTimeout(() => {
          early.delete(threadId);
          const now = getData().threads.find((x) => x.id === threadId);
          if (
            !now ||
            now.snoozedUntil === undefined ||
            now.snoozedUntil <= Date.now()
          )
            return;
          const ask: V3Ask = {
            ...script,
            id: `a-${threadId}-snooze`,
            threadId,
            waiting: 0,
            at: Date.now(),
          };
          setData((d) => ({
            ...d,
            asks: [ask, ...d.asks],
            threads: threadPatch(d, (t) => t.id === threadId, {
              status: "needs",
              askId: ask.id,
              cameBackAt: Date.now(),
              now: undefined,
              live: undefined,
            }),
          }));
          toast(
            `${agentNameOf(getData(), th.agentId)} needs you — the thread woke early`,
          );
        }, 20_000),
      );
    },
    wakeThread: (threadId) => {
      clearEarlyWake(threadId);
      patch(threadId, { snoozedUntil: undefined, cameBackAt: Date.now() });
      toast("Awake · it is back on top of the list");
    },
    setAutoSettle: (threadId, enabled) => {
      patch(threadId, { autoSettleOff: !enabled });
      toast(
        enabled
          ? "Auto-settle on · it parks itself when it goes quiet"
          : "Auto-settle off · it stays where you put it",
      );
    },
  };
}
