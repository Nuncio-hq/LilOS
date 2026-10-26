import { CornerLeftUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { ago, Btn, Spinner } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { ThreadPill } from "./v3-live";
import { AgentAvatar, StatusDot } from "./v3-marks";
import {
  agentOf,
  boardStatus,
  childrenOf,
  FORMER_AGENT,
  liveHelpersOf,
  threadOf,
} from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import type { V3Thread } from "./v3-types";

/* Parent ↔ helper lineage (D-#847): a hand-off is an ordinary thread with
   `parentId` back to the thread that created it (D-#844). A child's page
   leads with the parent it belongs to; a parent's page lists its helpers —
   agent, state, elapsed, Stop — the way T3 Code's thread details list
   subagents. The rows are the only place helpers appear: the lists never
   draw them. */

/** Buttons inside a clickable row act on their own; they must not open the
   row (or a card that contains it). */
function Actions({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

/** Still on the job (a Stop does something); finished helpers just open. */
const stoppable = (t: V3Thread) =>
  t.status !== "done" &&
  t.status !== "idle" &&
  t.status !== "failed" &&
  t.status !== "planned";

/** One helper: its agent, what it is doing, since when — and Stop while it
   is still on the job. The row opens the helper's own thread. */
export function HelperRow({
  data,
  thread: t,
  go,
  act,
}: V3PageProps & { thread: V3Thread }) {
  const who = agentOf(data, t.agentId);
  return (
    <RowButton
      opens={{ page: "thread", id: t.id }}
      onClick={() => go({ page: "thread", id: t.id })}
      className="flex min-h-[42px] items-center gap-3 border-[var(--v3-line)] border-b py-1.5 text-[13.5px] last:border-b-0"
    >
      <span className="grid w-4 shrink-0 place-items-center">
        {t.status === "working" ? <Spinner /> : <StatusDot status={t.status} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <AgentAvatar data={data} agent={who} size={18} />
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">
            {who?.name ?? FORMER_AGENT}
          </span>
          <span className="text-muted-foreground"> · {t.title}</span>
        </span>
      </span>
      <span className="hidden shrink-0 @min-[440px]:block">
        <ThreadPill status={t.status} />
      </span>
      <span className="w-10 shrink-0 text-right text-[12.5px] text-muted-foreground">
        {ago(t.minutes)}
      </span>
      {stoppable(t) && (
        <Actions>
          <Btn small onClick={() => act.stop(t.id)}>
            Stop
          </Btn>
        </Actions>
      )}
    </RowButton>
  );
}

/** A child thread's banner: who it is helping. One line, opens the parent. */
export function ParentLine({
  data,
  thread,
  go,
}: {
  data: V3Data;
  thread: V3Thread;
  go: V3PageProps["go"];
}) {
  const parent = thread.parentId ? threadOf(data, thread.parentId) : undefined;
  if (!parent) return null;
  const who = agentOf(data, parent.agentId);
  return (
    <RowButton
      opens={{ page: "thread", id: parent.id }}
      onClick={() => go({ page: "thread", id: parent.id })}
      className="flex min-h-[40px] items-center gap-2.5 border-[var(--v3-line)] border-b px-4 py-1.5 text-[13.5px]"
    >
      <CornerLeftUpIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="shrink-0 text-muted-foreground/70">Helper of</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {parent.title}
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground @min-[520px]:flex">
        <AgentAvatar data={data} agent={who} size={16} />
        <span className="truncate">{who?.name ?? FORMER_AGENT}</span>
      </span>
      <StatusDot status={boardStatus(data, parent)} />
    </RowButton>
  );
}

/** A parent thread's helpers, on the thread's own page (D-#847): who is
   running for it, how long, and the way to stop or watch each. */
export function HelpersBlock({
  data,
  thread,
  go,
  act,
}: V3PageProps & { thread: V3Thread }) {
  const kids = childrenOf(data, thread.id);
  if (kids.length === 0) return null;
  const live = liveHelpersOf(data, thread.id).length;
  return (
    <div className="border-[var(--v3-line)] border-b">
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-1.5 text-[12.5px] text-muted-foreground/70">
        <span className="font-medium text-muted-foreground">Helpers</span>
        <span>
          {live > 0
            ? `${live} of ${kids.length} still on it`
            : `${kids.length} finished`}
        </span>
      </div>
      <div className="px-2 pb-1.5">
        {kids.map((k) => (
          <HelperRow key={k.id} data={data} thread={k} go={go} act={act} />
        ))}
      </div>
    </div>
  );
}

/** What a thread page draws between the toolbar and the conversation: the
   parent a helper belongs to, and a parent's helpers. Both absent on an
   ordinary thread — the page is exactly as before (D-#19). */
export function ThreadLineage({
  data,
  thread,
  go,
  act,
}: V3PageProps & { thread: V3Thread }) {
  return (
    <>
      <ParentLine data={data} thread={thread} go={go} />
      <HelpersBlock data={data} thread={thread} go={go} act={act} />
    </>
  );
}

/** A muted hint a listed thread wears when helpers work for it
   ("· 3 helpers"). No children, no hint (D-#19). */
export function HelpersHint({
  data,
  thread,
  className,
}: {
  data: V3Data;
  thread: V3Thread;
  className?: string;
}) {
  const n = childrenOf(data, thread.id).length;
  if (n === 0) return null;
  return (
    <span
      className={cn("shrink-0 text-muted-foreground/60", className)}
      title={`${n} ${n === 1 ? "helper" : "helpers"}`}
    >
      {n} {n === 1 ? "helper" : "helpers"}
    </span>
  );
}
