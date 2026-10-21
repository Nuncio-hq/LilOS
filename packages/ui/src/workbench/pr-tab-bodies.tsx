import { CopyIcon } from "lucide-react";
import { Textarea } from "../components/ui/textarea";
import { plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar, HumanAvatar } from "../shell/avatars";
import type { Employee, GitCommit, HumanFn, PullRequest } from "../types";
import { CHECK_ICON } from "./pr-merge-box";
import { CARD, WbBtn } from "./wb-bits";

/* The PR tab's Commits, Checks and Discussion bodies — the sub-tab content under the header card. */

const ICON_BTN =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground";

export { ICON_BTN };

export function PrCommits({
  commits,
  author,
}: {
  commits: GitCommit[];
  author: string;
}) {
  return (
    <div className={cn(CARD, "divide-y divide-[var(--v3-line)]")}>
      {commits.map((c, i) => (
        <div key={c.hash} className="flex items-center gap-3 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{c.message}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {i === 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  Current
                </span>
              )}
              {i === 0 && "·"}
              {author}·
              <code className="rounded bg-[var(--v3-soft)] px-1 font-mono">
                {c.hash}
              </code>
              ·{plural(c.files.length, "file")}
            </div>
          </div>
          <button
            type="button"
            className={ICON_BTN}
            title="Copy hash"
            aria-label="Copy hash"
            onClick={() => navigator.clipboard?.writeText(c.hash)}
          >
            <CopyIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PrChecks({ pr }: { pr: PullRequest }) {
  const n = (s: PullRequest["checks"][number]["status"]) =>
    pr.checks.filter((c) => c.status === s).length;
  const total = pr.checks.length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 text-center">
        {(["pending", "failed", "passed", "skipped"] as const).map((s) => (
          <div key={s}>
            <div className="text-[20px] tabular-nums">{n(s)}</div>
            <div className="text-[12px] text-muted-foreground">
              {s === "passed" ? "successful" : s}
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-1 overflow-hidden rounded-full bg-[var(--v3-soft)]">
        <div
          className="bg-emerald-500 transition-all"
          style={{ width: `${(n("passed") / total) * 100}%` }}
        />
        <div
          className="bg-red-500"
          style={{ width: `${(n("failed") / total) * 100}%` }}
        />
        <div
          className="bg-zinc-300 dark:bg-zinc-600"
          style={{ width: `${(n("skipped") / total) * 100}%` }}
        />
      </div>
      <div className={cn(CARD, "divide-y divide-[var(--v3-line)]")}>
        {pr.checks.map((c) => (
          <div
            key={c.name}
            className="flex items-center gap-2.5 px-3.5 py-2 text-[13px]"
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
  );
}

export function PrDiscussion({
  pr,
  lead,
  author,
  human,
  say,
  draft,
  onDraft,
  busy,
  onComment,
  onSubmit,
}: {
  pr: PullRequest;
  lead?: Employee;
  author: string;
  human: HumanFn;
  say?: (t: string) => void;
  draft: string;
  onDraft: (t: string) => void;
  busy: "comment" | "merge" | null;
  /** The composer renders only when the app passes a comment handler (D-#19). */
  onComment?: unknown;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      {pr.comments.map((c, i) => (
        <div key={i} className="flex gap-3">
          {human(c.from) ? (
            <HumanAvatar human={human(c.from)!} />
          ) : (
            <HermesAvatar className="size-8" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-[13px]">
              <span className="font-medium">
                {/* Real forge comments carry the gh login; mock ones an
                    employee id — show the comment's own author. */}
                {c.from === lead?.id ? author : (human(c.from)?.name ?? c.from)}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {c.time}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-6 text-foreground/90">
              {c.text}
            </p>
            {c.monitor && say && (
              <label className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5 accent-foreground"
                  onChange={(e) =>
                    say(
                      e.target.checked
                        ? "PR monitoring off for this thread"
                        : "PR monitoring on",
                    )
                  }
                />
                Disable automatic comment, CI and merge-conflict monitoring
              </label>
            )}
          </div>
        </div>
      ))}
      {!!onComment && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder="Add a comment… (Builder picks it up in this thread)"
            className="min-h-20 rounded-[7px] border-foreground/15 text-[13px]"
          />
          <div className="flex justify-end">
            <WbBtn
              primary
              type="submit"
              disabled={!draft.trim() || busy !== null}
            >
              {busy === "comment" ? "Posting…" : "Comment"}
            </WbBtn>
          </div>
        </form>
      )}
    </div>
  );
}
