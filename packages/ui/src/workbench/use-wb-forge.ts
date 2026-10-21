import { useEffect, useRef } from "react";
import type {
  HostAccessors,
  MergeMethod,
  PullRequest,
  Thread,
  WbTab,
} from "../types";
import { ghError } from "./use-wb-open";
import type { WbProbe } from "./use-wb-probe";

/* The PR tab's truth and its two actions (issue #37). */
export function useWbForge({
  thread,
  host,
  liveMode,
  liveCwd,
  probe,
  shownTab,
  reloadPr,
  landPr,
  prPoll,
  onPrComment,
  onPrMerge,
  onPr,
  say,
}: {
  thread: Thread;
  host?: HostAccessors;
  liveMode: boolean;
  liveCwd?: string;
  probe: WbProbe["probe"];
  shownTab: WbTab | undefined;
  reloadPr: WbProbe["reloadPr"];
  landPr: WbProbe["landPr"];
  prPoll: WbProbe["prPoll"];
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  onPr?: (pr: PullRequest | null) => void;
  say?: (t: string, opts?: { error?: boolean }) => void;
}) {
  /* In live mode the forge's answer is authoritative — `{pr}` shows it,
     `{pr:null}` shows a plain "no PR on this branch" state, `{error}` reads
     the `gh` failure plainly (#114 AC-5). A silent method (outer null) hides
     the tab. Without a host the session-carried thread.pr stays (mock). */
  const prShown = liveMode ? (probe?.pr?.pr ?? null) : thread.pr;
  const prError = liveMode ? probe?.pr?.error : undefined;
  const liveForge = liveMode && prShown != null && liveCwd != null;
  /* #579 AC-1: the live forge read is the header's "PR #N" truth — report
     it upward once the probe answers so a just-created/merged PR reaches
     the chip without a reload. An unanswered probe reports nothing. */
  const probePr = probe?.pr;
  useEffect(() => {
    if (!liveMode || !probePr) return;
    onPr?.(probePr.pr ?? null);
  }, [probePr, liveMode, onPr]);
  /* #429 AC-2: landing on the PR tab signals a fresh forge read — the
     scheduler coalesces repeat visits (and the OS-window-focus signal)
     into one `gh` call. */
  const prTabShown = shownTab === "pr";
  const wasPrTab = useRef(false);
  useEffect(() => {
    const became = prTabShown && !wasPrTab.current;
    wasPrTab.current = prTabShown;
    if (became) prPoll.current?.signal();
  }, [prTabShown]);

  const prComment =
    liveForge && host?.prComment && liveCwd
      ? async (t: string) => {
          try {
            await host.prComment?.(liveCwd, t);
            await reloadPr();
            say?.("Comment posted via gh");
          } catch (e) {
            say?.(`Comment failed — ${ghError(e)}`, { error: true });
          }
        }
      : onPrComment;
  const prMerge =
    liveForge && host?.prMerge && liveCwd
      ? async (m: MergeMethod) => {
          try {
            const pr = await host.prMerge?.(liveCwd, m);
            if (pr) landPr({ pr });
            if (pr?.status === "merged")
              say?.(
                `Merged #${pr.number} into ${pr.base} · gh pr merge --${m}`,
              );
            else
              say?.(`gh pr merge returned but the PR is ${pr?.status}`, {
                error: true,
              });
          } catch (e) {
            say?.(`Merge failed — ${ghError(e)}`, { error: true });
          }
        }
      : onPrMerge;
  return { prShown, prError, prComment, prMerge };
}
