import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { CheckRun, MergeMethod, PullRequest } from "../types";
import { WbBtn } from "./wb-bits";

/* The PR header card's lower half: one checks/merge status line that opens
   the mergeability detail, then Squash and merge → a confirmation that names
   the base branch and the method before `gh pr merge` runs (#37 AC-3). */

export const CHECK_ICON: Record<CheckRun["status"], React.ReactNode> = {
  pending: (
    <CircleDashedIcon className="size-4 animate-spin text-work [animation-duration:3s]" />
  ),
  passed: <CircleCheckIcon className="size-4 text-emerald-600" />,
  failed: <CircleXIcon className="size-4 text-red-600" />,
  skipped: <CircleMinusIcon className="size-4 text-muted-foreground" />,
};

const MERGE_METHODS: { id: MergeMethod; label: string }[] = [
  { id: "squash", label: "Squash and merge" },
  { id: "merge", label: "Create a merge commit" },
  { id: "rebase", label: "Rebase and merge" },
];

export function MergeBox({
  pr,
  pending,
  failed,
  author,
  open,
  onToggle,
  confirming,
  onConfirming,
  method,
  onMethod,
  busy,
  onMerge,
  onRunMerge,
}: {
  pr: PullRequest;
  pending: number;
  failed: number;
  author: string;
  open: boolean;
  onToggle: () => void;
  confirming: boolean;
  onConfirming: (v: boolean) => void;
  method: MergeMethod;
  onMethod: (m: MergeMethod) => void;
  busy: "comment" | "merge" | null;
  /** Merge controls render only when the app passes a handler (D-#19). */
  onMerge?: unknown;
  onRunMerge: () => void;
}) {
  const merged = pr.status === "merged";
  const closed = pr.status === "closed";
  const conflicting = pr.mergeable === "conflicting";
  return (
    <div className="border-[var(--v3-line)] border-t">
      <button
        type="button"
        className="flex h-10 w-full items-center gap-2 px-4 text-left text-[13.5px] hover:bg-[var(--v3-hover)]"
        onClick={onToggle}
        aria-expanded={open}
      >
        {merged ? (
          <GitMergeIcon className="size-4 text-violet-600 dark:text-violet-400" />
        ) : closed ? (
          <GitPullRequestClosedIcon className="size-4 text-muted-foreground" />
        ) : failed ? (
          CHECK_ICON.failed
        ) : pending ? (
          CHECK_ICON.pending
        ) : (
          CHECK_ICON.passed
        )}
        <span>
          {merged
            ? `Merged into ${pr.base}`
            : closed
              ? `Closed · ${pr.base} unchanged`
              : failed
                ? `${failed} check${failed > 1 ? "s" : ""} failing`
                : pending
                  ? `Checks running · ${pr.checks.length - pending}/${pr.checks.length} done`
                  : "Ready to merge"}
        </span>
        {merged && pr.merged && (
          <span className="truncate text-[12.5px] text-muted-foreground">
            · {pr.merged.by} · {pr.merged.at} · branch {pr.head} deleted
          </span>
        )}
        {!merged && !pending && !failed && (
          <span className="truncate text-[12.5px] text-muted-foreground">
            · {pr.checks.filter((c) => c.status === "passed").length} passed ·
            review requested from Reviewer
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-[var(--v3-line)] border-t px-4 py-3 text-[13px]">
          <div className="flex items-center gap-2">
            {conflicting ? (
              <>
                {CHECK_ICON.failed}
                <span>
                  This branch has conflicts with{" "}
                  <span className="font-mono">{pr.base}</span>
                </span>
              </>
            ) : pr.mergeable === "unknown" ? (
              <>
                <CircleDashedIcon className="size-4 text-muted-foreground" />
                <span>GitHub is still checking mergeability…</span>
              </>
            ) : (
              <>
                {CHECK_ICON.passed}
                <span>
                  No conflicts with <span className="font-mono">{pr.base}</span>
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pending
              ? CHECK_ICON.pending
              : failed
                ? CHECK_ICON.failed
                : CHECK_ICON.passed}
            {pr.checks.length - pending - failed} of {pr.checks.length} checks
            finished{failed ? `, ${failed} failing` : ""}
          </div>
        </div>
      )}
      {!merged && !closed && !!onMerge && (
        <div className="border-[var(--v3-line)] border-t px-4 py-3">
          {confirming ? (
            <div className="space-y-2.5" data-mergeconfirm>
              <div className="text-[13px]">
                Merge <span className="font-mono">#{pr.number}</span> into{" "}
                <span className="font-medium font-mono">{pr.base}</span>?
              </div>
              <div className="space-y-1">
                {MERGE_METHODS.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="merge-method"
                      className="size-3.5 accent-foreground"
                      checked={method === m.id}
                      onChange={() => onMethod(m.id)}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <WbBtn primary disabled={busy !== null} onClick={onRunMerge}>
                  <GitMergeIcon />
                  {busy === "merge" ? "Merging…" : "Confirm merge"}
                </WbBtn>
                <WbBtn
                  className="border-transparent"
                  disabled={busy !== null}
                  onClick={() => onConfirming(false)}
                >
                  Cancel
                </WbBtn>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <WbBtn
                primary
                disabled={pending > 0 || failed > 0 || conflicting}
                onClick={() => onConfirming(true)}
              >
                <GitMergeIcon />
                Squash and merge
              </WbBtn>
              <span className="text-[12.5px] text-muted-foreground">
                {conflicting
                  ? `Resolve the conflicts with ${pr.base} first`
                  : pending
                    ? "Waiting for checks"
                    : failed
                      ? `${author} is fixing CI in this thread`
                      : "You have write access on this repo."}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
