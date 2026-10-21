import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
} from "lucide-react";
import type { PullRequest } from "../types";

/* The PR card an agent posts under the turn that opened the PR. */
export function PrCard({
  pr,
  author,
  onOpen,
}: {
  pr: PullRequest;
  author: string;
  onOpen: () => void;
}) {
  const pending = pr.checks.filter((c) => c.status === "pending").length;
  const merged = pr.status === "merged";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-prcard
      className="flex w-full max-w-lg items-center gap-3 rounded-[10px] border border-[var(--v3-line)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--v3-hover)]"
    >
      {merged ? (
        <GitMergeIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-foreground">
          <span className="text-muted-foreground/70">#{pr.number}</span>{" "}
          <span className="font-medium">{pr.title}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span className="truncate">{pr.repo}</span>·
          <span className="truncate">{author}</span>·
          {merged ? (
            <span className="text-violet-600">merged</span>
          ) : pending ? (
            <span className="flex items-center gap-1 text-amber-600">
              <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
              checks {pr.checks.length - pending}/{pr.checks.length}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600">
              <CircleCheckIcon className="size-3" />
              checks passed
            </span>
          )}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}
