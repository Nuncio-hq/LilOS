import { ChevronRightIcon, CircleDotIcon, ShieldAlertIcon } from "lucide-react";
import { PHASE_LABEL } from "../lib/helpers";
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
  const last = thread.replies[thread.replies.length - 1];
  if (!last) return null;
  const workers = [
    ...new Set(thread.replies.map((r) => r.from).filter((f) => emp(f))),
  ];
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
        {thread.replies.length} replies
      </span>
      {thread.replies.some((r) => r.approval) && (
        <span className="flex items-center gap-1 font-medium text-tint-text">
          <ShieldAlertIcon className="size-3" />
          needs you
        </span>
      )}
      {last.streaming || last.live ? (
        <span className="flex items-center gap-1 text-muted-foreground">
          <CircleDotIcon className="size-3 animate-pulse text-work" />
          {last.phase ? PHASE_LABEL[last.phase] : "working"}
        </span>
      ) : null}
      <ChevronRightIcon className="size-3.5 text-muted-foreground" />
    </button>
  );
}
