import {
  ArrowUpRightIcon,
  CopyIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { type ComponentProps, useState } from "react";
import { MessageResponse } from "../components/ai-elements/message";
import { ScrollArea } from "../components/ui/scroll-area";
import { plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  Diff,
  Employee,
  GitCommit,
  HumanFn,
  MergeMethod,
  PrError,
  PullRequest,
} from "../types";
import { DiffStat, DiffView } from "./diff-view";
import { PrFailure } from "./pr-failure";
import { MergeBox } from "./pr-merge-box";
import { ICON_BTN, PrChecks, PrCommits, PrDiscussion } from "./pr-tab-bodies";
import { CARD, PANEL, WbBtn, WbEmpty } from "./wb-bits";

/* PR view in the prototype's PrTab shape: one hairline header card (title,
   branch, status, merge box) over a quiet sub-tab strip. */
type PrTab = "changes" | "description" | "discussion" | "commits" | "checks";

/* Status is the only colour on the header: open emerald, merged violet,
   closed muted. */
const PILL = {
  open: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300",
  merged:
    "bg-violet-50 text-violet-700 dark:bg-violet-400/12 dark:text-violet-300",
  closed:
    "bg-stone-100 text-stone-500 dark:bg-stone-400/12 dark:text-stone-400",
};

export function PrPanel({
  pr,
  diffs,
  commits,
  lead,
  human,
  onComment,
  onMerge,
  say,
}: {
  pr: PullRequest;
  diffs: Diff[];
  commits: GitCommit[];
  lead?: Employee;
  human: HumanFn;
  /* Controls render only when their handler is passed (issue #19): no onMerge → no merge row,
     no onComment → no comment form, no say → no toast-only buttons/checkbox. Handlers may return
     a promise (the forge round-trips `gh`); the panel stays busy until it settles. */
  onComment?: (t: string) => void | Promise<void>;
  onMerge?: (method: MergeMethod) => void | Promise<void>;
  say?: (t: string) => void;
}) {
  const [tab, setTab] = useState<PrTab>("description");
  const [draft, setDraft] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [busy, setBusy] = useState<"comment" | "merge" | null>(null);
  const merged = pr.status === "merged";
  const closed = pr.status === "closed";
  const runMerge = () => {
    if (!onMerge) return;
    setBusy("merge");
    void Promise.resolve(onMerge(method)).finally(() => {
      setBusy(null);
      setConfirming(false);
    });
  };
  const runComment = () => {
    if (!onComment || !draft.trim()) return;
    const t = draft.trim();
    setBusy("comment");
    void Promise.resolve(onComment(t))
      .then(() => setDraft(""))
      .finally(() => setBusy(null));
  };
  const n = (s: PullRequest["checks"][number]["status"]) =>
    pr.checks.filter((c) => c.status === s).length;
  const pending = n("pending"),
    failed = n("failed");
  const add = diffs.reduce((x, d) => x + d.add, 0),
    del = diffs.reduce((x, d) => x + d.del, 0);
  const author = lead?.name ?? pr.author;
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const tabs: { id: PrTab; label: string; count?: number }[] = [
    { id: "changes", label: "Changes", count: diffs.length },
    { id: "description", label: "Description" },
    { id: "discussion", label: "Discussion", count: pr.comments.length },
    { id: "commits", label: "Commits", count: commits.length },
    { id: "checks", label: "Checks", count: pr.checks.length },
  ];
  const state = merged ? "merged" : closed ? "closed" : "open";
  const StateIcon = merged
    ? GitMergeIcon
    : closed
      ? GitPullRequestClosedIcon
      : GitPullRequestIcon;
  return (
    <ScrollArea className="h-full">
      <div className={cn(PANEL, "space-y-5 text-[13px]")} data-pr={pr.number}>
        <div className={cn(CARD, "overflow-hidden")}>
          <div className="px-4 py-3.5">
            <div className="flex items-start gap-2.5">
              <StateIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] text-foreground leading-snug">
                  <span className="font-medium">{pr.title}</span>{" "}
                  <span className="text-muted-foreground/70">#{pr.number}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <GitBranchIcon className="size-3.5 shrink-0" />
                  <span className="max-w-48 truncate font-mono text-[12px]">
                    {pr.head}
                  </span>
                  <span>→</span>
                  <span className="truncate font-mono text-[12px]">
                    {pr.base}
                  </span>
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex h-[22px] shrink-0 items-center rounded-full px-2.5 font-medium text-[12.5px]",
                  PILL[state],
                )}
              >
                {merged ? "Merged" : closed ? "Closed" : "Open"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground">
              <span className="flex items-center gap-1.5 text-foreground/80">
                <HermesAvatar name={author} className="size-4" />
                {author}
              </span>
              <span>{pr.repo}</span>
              <span>
                {pr.merged ? (
                  <>
                    Merged by {pr.merged.by} at {pr.merged.at} · squash{" "}
                    <code className="font-mono">{pr.merged.sha}</code>
                  </>
                ) : (
                  <>
                    Opened {pr.opened} · {plural(diffs.length, "file")}
                  </>
                )}
              </span>
              <DiffStat add={add} del={del} />
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <WbBtn onClick={() => setTab("discussion")}>
                <MessageSquareTextIcon />
                Comment
              </WbBtn>
              {say && (
                <WbBtn onClick={() => say(`open ${url}`)}>
                  GitHub
                  <ArrowUpRightIcon />
                </WbBtn>
              )}
              <button
                type="button"
                className={cn(ICON_BTN, "ml-auto")}
                title="Copy PR link"
                onClick={() => {
                  navigator.clipboard?.writeText(url);
                  say?.("PR link copied");
                }}
              >
                <CopyIcon className="size-3.5" />
              </button>
            </div>
          </div>
          <MergeBox
            pr={pr}
            pending={pending}
            failed={failed}
            author={author}
            open={mergeOpen}
            onToggle={() => setMergeOpen(!mergeOpen)}
            confirming={confirming}
            onConfirming={setConfirming}
            method={method}
            onMethod={setMethod}
            busy={busy}
            onMerge={onMerge}
            onRunMerge={runMerge}
          />
        </div>

        {/* Sub-tabs */}
        <div className="no-scrollbar flex items-center gap-4 overflow-x-auto border-[var(--v3-line)] border-b">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              data-prtab={t.id}
              className={cn(
                "-mb-px shrink-0 border-b-2 py-2 text-[13px] transition-colors",
                tab === t.id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="ml-1.5 text-muted-foreground tabular-nums">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "description" && (
          <MessageResponse className="lilos-prose">{pr.body}</MessageResponse>
        )}
        {tab === "changes" && (
          <div className="space-y-3">
            {diffs.map((d) => (
              <DiffView key={d.path} d={d} />
            ))}
          </div>
        )}
        {tab === "commits" && <PrCommits commits={commits} author={author} />}
        {tab === "checks" && <PrChecks pr={pr} />}
        {tab === "discussion" && (
          <PrDiscussion
            pr={pr}
            lead={lead}
            author={author}
            human={human}
            say={say}
            draft={draft}
            onDraft={setDraft}
            busy={busy}
            onComment={onComment}
            onSubmit={runComment}
          />
        )}
      </div>
    </ScrollArea>
  );
}

/** The PR tab's body: the PR; the plain reason `gh` failed, with one next
    step — raw stderr stays behind Details (#114 AC-5); or none yet. */
export function PrTabBody({
  pr,
  error,
  branch,
  onRetry,
  ...panel
}: {
  pr?: PullRequest | null;
  error?: PrError;
  /** Named in the "no pull request" line. */
  branch: string;
  onRetry: () => void;
} & Omit<ComponentProps<typeof PrPanel>, "pr">) {
  if (pr) return <PrPanel pr={pr} {...panel} />;
  if (error)
    return (
      <PrFailure
        error={error}
        onRetry={onRetry}
        employeeName={panel.lead?.name}
      />
    );
  return (
    <WbEmpty>
      No pull request on <span className="font-mono">⎇ {branch}</span> yet.
    </WbEmpty>
  );
}
