import { ChevronRightIcon } from "lucide-react";
import { threadState } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, Thread, Work } from "../types";

/* The clickable chip under a channel message that opens its thread. */
export function ThreadSummary({
  thread,
  work,
  emp,
  onOpen,
}: {
  thread: Thread;
  work: Work | null;
  emp: EmpFn;
  onOpen: () => void;
}) {
  if (!thread.replies.length) return null;
  const workers = [
    ...new Set(thread.replies.map((r) => r.from).filter((f) => emp(f))),
  ];
  /* #583 AC-2/AC-3: the chip states the thread — needs you / running /
     failed / stopped — plus any live background job; #585: system notes
     aren't replies. */
  const replyCount = thread.replies.filter((r) => !r.system).length;
  const state = threadState(thread);
  /* The live `jobs` list wins once the feed lands; the relay-stamped
     `bgJobs` count (#583) covers the pre-attach/released window. */
  const bgJobs =
    thread.jobs?.filter((j) => j.status === "running").length ??
    thread.bgJobs ??
    0;
  return (
    <button
      onClick={onOpen}
      title={
        [work?.ticket, work?.branch].filter(Boolean).join(" · ") || undefined
      }
      className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 lilos-lift rounded-full bg-accent px-2.5 py-1 text-left text-xs hover:bg-foreground/10 [&>*]:shrink-0 [&>*]:whitespace-nowrap"
    >
      <span className="flex -space-x-1.5">
        {workers.map((w) => (
          <HermesAvatar
            key={w}
            name={emp(w)?.name}
            className="size-5 rounded-full ring-2 ring-background"
          />
        ))}
      </span>
      <span className="font-medium text-tint-text">
        {replyCount} {replyCount === 1 ? "reply" : "replies"}
      </span>
      {state?.word === "needs you" && (
        <span
          title="Needs you"
          className="grid size-4 place-items-center rounded-full bg-primary font-bold text-[10px] text-primary-foreground"
        >
          <span aria-hidden>!</span>
          <span className="sr-only">needs you</span>
        </span>
      )}
      {state && (
        <span
          data-thread-state={state.word}
          className={cn(
            "font-medium",
            state.word === "needs you" && "text-amber-600",
            state.word === "running" && "text-work",
            state.word === "failed" && "text-red-600",
            state.word === "stopped" &&
              "text-muted-foreground dark:text-foreground/80",
          )}
        >
          {state.word}
        </span>
      )}
      {bgJobs > 0 && (
        <span data-bg-jobs className="text-muted-foreground">
          {bgJobs} in background
        </span>
      )}
      <ChevronRightIcon className="size-3.5 text-muted-foreground" />
    </button>
  );
}
