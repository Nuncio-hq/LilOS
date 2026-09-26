import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  CopyIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { useState } from "react";
import { MessageResponse } from "../components/ai-elements/message";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Textarea } from "../components/ui/textarea";
import { plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar, HumanAvatar } from "../shell/avatars";
import type {
  CheckRun,
  Diff,
  Employee,
  GitCommit,
  HumanFn,
  PullRequest,
} from "../types";
import { DiffStat, DiffView } from "./diff-view";

/* PR view modelled on Devin's PR tab: status pill + actions, repo/title/meta, merge box, sub-tabs. */
type PrTab = "changes" | "description" | "discussion" | "commits" | "checks";
const CHECK_ICON: Record<CheckRun["status"], React.ReactNode> = {
  pending: (
    <CircleDashedIcon className="size-4 animate-spin text-amber-500 [animation-duration:3s]" />
  ),
  passed: <CircleCheckIcon className="size-4 text-emerald-600" />,
  failed: <CircleXIcon className="size-4 text-red-600" />,
  skipped: <CircleMinusIcon className="size-4 text-muted-foreground" />,
};
export function PrPanel({
  pr,
  diffs,
  commits,
  lead,
  session,
  human,
  onComment,
  onMerge,
  say,
}: {
  pr: PullRequest;
  diffs: Diff[];
  commits: GitCommit[];
  lead?: Employee;
  session: string;
  human: HumanFn;
  /* Controls render only when their handler is passed (issue #19): no onMerge → no merge row,
     no onComment → no comment form, no say → no toast-only buttons/checkbox. */
  onComment?: (t: string) => void;
  onMerge?: () => void;
  say?: (t: string) => void;
}) {
  const [tab, setTab] = useState<PrTab>("description");
  const [draft, setDraft] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const merged = pr.status === "merged";
  const n = (s: CheckRun["status"]) =>
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
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4 text-[14px]" data-pr={pr.number}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 font-medium text-[13px]",
              merged
                ? "bg-violet-500/12 text-violet-700"
                : "bg-emerald-500/12 text-emerald-700",
            )}
          >
            {merged ? (
              <GitMergeIcon className="size-3.5" />
            ) : (
              <GitPullRequestIcon className="size-3.5" />
            )}
            {merged ? "Merged" : "Open"}
          </span>
          <div className="ml-auto flex items-center gap-1 text-[13px] text-muted-foreground">
            <Button
              variant="ghost"
              size="icon-sm"
              title="Copy PR link"
              onClick={() => {
                navigator.clipboard?.writeText(url);
                say?.("PR link copied");
              }}
            >
              <CopyIcon />
            </Button>
            {say && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => say(`open ${url}`)}
              >
                GitHub
                <ArrowUpRightIcon />
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTab("discussion")}
            >
              <MessageSquareTextIcon />
              Comment
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[13px] text-muted-foreground">
            {pr.repo} · #{pr.number}
          </div>
          <h2 className="font-semibold text-[18px] leading-snug tracking-[-0.01em]">
            {pr.title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground/80">
            <HermesAvatar className="size-4" />
            {author}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[12px]">
              {pr.base}
            </span>
            ←
            <span className="max-w-48 truncate rounded-full bg-muted px-2 py-0.5 font-mono text-[12px]">
              {pr.head}
            </span>
          </span>
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

        {/* Merge box */}
        <div className="overflow-hidden rounded-xl border">
          <button
            type="button"
            className="flex h-11 w-full items-center gap-2.5 px-3.5 text-left font-medium hover:bg-muted/40"
            onClick={() => setMergeOpen(!mergeOpen)}
          >
            {merged ? (
              <GitMergeIcon className="size-4 text-violet-600" />
            ) : failed ? (
              <CircleXIcon className="size-4 text-red-600" />
            ) : pending ? (
              <CircleDashedIcon className="size-4 animate-spin text-amber-500 [animation-duration:3s]" />
            ) : (
              <CircleCheckIcon className="size-4 text-emerald-600" />
            )}
            <span>
              {merged
                ? `Merged into ${pr.base}`
                : failed
                  ? `${failed} check${failed > 1 ? "s" : ""} failing`
                  : pending
                    ? `Checks running · ${pr.checks.length - pending}/${pr.checks.length} done`
                    : "Ready to merge"}
            </span>
            {merged && pr.merged && (
              <span className="font-normal text-[13px] text-muted-foreground">
                · {pr.merged.by} · {pr.merged.at} · branch {pr.head} deleted
              </span>
            )}
            {!merged && !pending && !failed && (
              <span className="font-normal text-[13px] text-muted-foreground">
                · {pr.checks.filter((c) => c.status === "passed").length} passed
                · review requested from Reviewer
              </span>
            )}
            <ChevronDownIcon
              className={cn(
                "ml-auto size-4 text-muted-foreground transition-transform",
                mergeOpen && "rotate-180",
              )}
            />
          </button>
          {mergeOpen && (
            <div className="space-y-2 border-t px-3.5 py-3 text-[13px]">
              <div className="flex items-center gap-2">
                <CircleCheckIcon className="size-4 text-emerald-600" />
                No conflicts with <span className="font-mono">{pr.base}</span>
              </div>
              <div className="flex items-center gap-2">
                {pending
                  ? CHECK_ICON.pending
                  : failed
                    ? CHECK_ICON.failed
                    : CHECK_ICON.passed}
                {pr.checks.length - pending - failed} of {pr.checks.length}{" "}
                checks finished{failed ? `, ${failed} failing` : ""}
              </div>
            </div>
          )}
          {!merged && onMerge && (
            <div className="flex items-center gap-2 border-t bg-muted/30 px-3.5 py-2.5">
              <Button
                size="sm"
                disabled={pending > 0 || failed > 0}
                onClick={onMerge}
              >
                <GitMergeIcon />
                Squash and merge
              </Button>
              <span className="text-muted-foreground text-xs">
                {pending
                  ? "Waiting for checks"
                  : failed
                    ? `${author} is fixing CI in ${session}`
                    : "You have write access on this repo."}
              </span>
            </div>
          )}
        </div>

        {/* Sub-tabs */}
        <div className="no-scrollbar flex items-center gap-4 overflow-x-auto border-b">
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
        {tab === "commits" && (
          <div className="space-y-2">
            {commits.map((c, i) => (
              <div
                key={c.hash}
                className="flex items-center gap-3 rounded-lg border px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.message}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    {i === 0 && (
                      <span className="text-emerald-600">Current</span>
                    )}
                    {i === 0 && "·"}
                    {author}·
                    <code className="rounded bg-muted px-1 font-mono">
                      {c.hash}
                    </code>
                    ·{plural(c.files.length, "file")}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Copy hash"
                  onClick={() => navigator.clipboard?.writeText(c.hash)}
                >
                  <CopyIcon />
                </Button>
              </div>
            ))}
          </div>
        )}
        {tab === "checks" && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 text-center">
              {(["pending", "failed", "passed", "skipped"] as const).map(
                (s) => (
                  <div key={s}>
                    <div className="text-[20px] tabular-nums">{n(s)}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {s === "passed" ? "successful" : s}
                    </div>
                  </div>
                ),
              )}
            </div>
            <div className="flex h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="bg-emerald-500 transition-all"
                style={{ width: `${(n("passed") / pr.checks.length) * 100}%` }}
              />
              <div
                className="bg-red-500"
                style={{ width: `${(failed / pr.checks.length) * 100}%` }}
              />
              <div
                className="bg-zinc-300"
                style={{ width: `${(n("skipped") / pr.checks.length) * 100}%` }}
              />
            </div>
            <div className="divide-y rounded-lg border">
              {pr.checks.map((c) => (
                <div
                  key={c.name}
                  className="flex items-center gap-2.5 px-3.5 py-2"
                  data-check={c.status}
                >
                  {CHECK_ICON[c.status]}
                  <span>{c.name}</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">
                    {c.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "discussion" && (
          <div className="space-y-4">
            {pr.comments.map((c, i) => (
              <div key={i} className="flex gap-3">
                {c.from === "oscar" && human("oscar") ? (
                  <HumanAvatar human={human("oscar")!} />
                ) : (
                  <HermesAvatar className="size-8" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">
                      {c.from === "oscar" ? "Oscar" : author}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {c.time}
                    </span>
                  </div>
                  <p className="mt-1 leading-6 text-foreground/90">{c.text}</p>
                  {c.monitor && say && (
                    <label className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-foreground"
                        onChange={(e) =>
                          say(
                            e.target.checked
                              ? "PR monitoring off for this session"
                              : "PR monitoring on",
                          )
                        }
                      />
                      Disable automatic comment, CI and merge-conflict
                      monitoring
                    </label>
                  )}
                </div>
              </div>
            ))}
            {onComment && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) {
                    onComment(draft.trim());
                    setDraft("");
                  }
                }}
              >
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add a comment… (Builder picks it up in this session)"
                  className="min-h-20 text-[14px]"
                />
                <div className="flex justify-end">
                  <Button size="sm" type="submit" disabled={!draft.trim()}>
                    Comment
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
