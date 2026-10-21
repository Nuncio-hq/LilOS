import { useEffect } from "react";
import {
  diffCommentsMessage,
  diffSendRoute,
  useDiffComments,
} from "../lib/diff-comments";
import { plural } from "../lib/helpers";
import type { WbProbeData } from "../lib/wb-probe-cache";
import type { Diff, Thread } from "../types";

/* #108: the review comments pinned on the Changes diff, and sending them to
   the agent. */
export function useWbReview({
  thread,
  diffs,
  liveMode,
  probe,
  running,
  steer,
  onSend,
  say,
}: {
  thread: Thread;
  diffs: Diff[];
  liveMode: boolean;
  probe: WbProbeData | null;
  running?: boolean;
  steer?: boolean;
  onSend?: (t: string) => void;
  say?: (t: string, opts?: { error?: boolean }) => void;
}) {
  /* Keyed by session so tab switches and Focus remounts keep them (module
     store, D-#320 rationale). `prune` re-runs whenever the shown diffs'
     patches move — resolved markers whose file changed drop off (AC-4),
     pending notes whose file or anchor vanished drop too. It only runs on
     real reads: live mode's `probe` is null until the first host read lands,
     and an empty list then would wipe every note on a panel remount. */
  const dc = useDiffComments(thread.session);
  const diffsReady = liveMode ? probe?.diffs != null : true;
  const diffsKey = diffsReady
    ? diffs.map((d) => `${d.path}\n${d.patch}`).join("\n\n")
    : null;
  useEffect(() => {
    if (diffsReady) dc.prune(diffs);
  }, [diffsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingCount = dc.comments.filter((c) => !c.resolved).length;
  const sendComments = () => {
    if (!onSend || pendingCount === 0) return;
    const route = diffSendRoute(!!running, !!steer);
    const sent = dc.resolveAll(
      new Map(diffs.map((d) => [d.path, d.patch])),
      route,
    );
    onSend(diffCommentsMessage(sent));
    say?.(
      route === "steer"
        ? `Sent ${plural(sent.length, "comment")} — steered into the running turn`
        : route === "queue"
          ? `Sent ${plural(sent.length, "comment")} — queued as the next prompt`
          : `Sent ${plural(sent.length, "comment")} to the agent`,
    );
  };
  return { dc, pendingCount, sendComments };
}
