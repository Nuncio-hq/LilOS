import type { Conversation } from "@lilos/contracts/app";
import type { SessionModel } from "./turn-model";

/**
 * A thread's status, the one word every surface shows for it (v3 Threads,
 * Home, People, the sidebar dots; #769). Derived here, once, from relay truth
 * plus the live engine fold, per D-#33 (plain status is mapped once, in
 * client-runtime): no screen keeps its own rule.
 *
 * Precedence, first match wins:
 * - `needs`   an open engine request is waiting on the user (a turn parked
 *             on it is not "working"),
 * - `working` a turn is running,
 * - `failed`  the last turn failed (cleared when a turn starts fresh),
 * - `unseen`  a turn finished past the user's read mark (D-#563),
 * - `idle`    everything else.
 */
export type ThreadStatus = "needs" | "working" | "failed" | "unseen" | "idle";

/** What the broadcast fold knows about a session nobody is watching. */
export interface SessionSignalLike {
  running: boolean;
  openRequests: { readonly size: number };
}

/**
 * Running and open-request count for one conversation. The broadcast-folded
 * signal is authoritative-or-equal: unwatched sessions get both from it (or
 * the row's `state` before the first seed), watched sessions reconcile it off
 * the synced model, so an attach/sync window never blinks a badge off. The
 * model's live turn still wins when it says "waiting".
 */
export function liveState(
  c: Conversation,
  model: SessionModel | undefined,
  signal: SessionSignalLike | undefined,
): { running: boolean; asks: number } {
  if (!c.engineRef) return { running: false, asks: 0 };
  const asks = Math.max(
    model?.openRequests.length ?? 0,
    signal?.openRequests.size ?? 0,
  );
  const running =
    (model?.live !== undefined && model.live.phase !== "waiting") ||
    (model?.live === undefined &&
      (signal?.running ?? c.state === "active") &&
      asks === 0);
  return { running, asks };
}

export function threadStatus(
  c: Conversation,
  model: SessionModel | undefined,
  signal: SessionSignalLike | undefined,
): ThreadStatus {
  const { running, asks } = liveState(c, model, signal);
  if (asks > 0) return "needs";
  if (running) return "working";
  if (c.turnFailure) return "failed";
  if (c.finishedSeq > c.readSeq) return "unseen";
  return "idle";
}
