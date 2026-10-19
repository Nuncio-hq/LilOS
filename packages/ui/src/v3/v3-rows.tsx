import { cn } from "../lib/utils";
import {
  Avatar,
  ago,
  RowButton,
  Spinner,
  StatusDot,
  StatusPill,
  TicketId,
} from "./v3-bits";
import { agentOf, ticketOf } from "./v3-model";
import type { V3Data, V3Route, V3Thread, V3Ticket } from "./v3-types";

/* Rows shared by the goal, project and agent pages: the same ticket or
   thread always looks the same wherever it is listed. */

export function TicketRow({
  data,
  ticket,
  go,
  owner,
}: {
  data: V3Data;
  ticket: V3Ticket;
  go: (r: V3Route) => void;
  /** Show who holds the ticket (omit on an agent's own page). */
  owner?: boolean;
}) {
  const who = agentOf(data, ticket.owner);
  return (
    <RowButton
      onClick={() => go({ page: "ticket", id: ticket.id })}
      className="flex min-h-[40px] items-center gap-3 border-[var(--v3-line)] border-b py-1.5 text-[14px]"
    >
      <span className="min-w-0 flex-1 truncate text-foreground">
        <TicketId id={ticket.id} />
        {ticket.title}
      </span>
      {owner && (
        <span className="flex w-[108px] shrink-0 items-center gap-2 text-[13.5px] text-muted-foreground">
          <Avatar name={who.name} tone={who.tone} size={18} />
          {who.name}
        </span>
      )}
      <span className="w-[96px] shrink-0">
        <StatusPill status={ticket.status} />
      </span>
      <span
        className={cn(
          "w-11 shrink-0 text-right text-[13px] text-muted-foreground",
          ticket.status === "stuck" &&
            "font-semibold text-red-600 dark:text-red-300",
        )}
      >
        {/* Done tickets show how long ago they finished, the rest how long they have sat. */}
        {ago(
          ticket.status === "done"
            ? (ticket.doneAgo ?? ticket.since)
            : ticket.since,
        )}
      </span>
    </RowButton>
  );
}

/** A thread row: spinner while it runs, a status dot otherwise. */
export function ThreadRow({
  data,
  thread,
  go,
  byAgent,
}: {
  data: V3Data;
  thread: V3Thread;
  go: (r: V3Route) => void;
  /** Name the agent instead of the ticket's owner-less context. */
  byAgent?: boolean;
}) {
  const who = agentOf(data, thread.agentId);
  const ticket = ticketOf(data, thread.ticketId);
  return (
    <RowButton
      onClick={() => go({ page: "thread", id: thread.id })}
      className="flex min-h-[40px] items-center gap-3 border-[var(--v3-line)] border-b py-1.5 text-[14px]"
    >
      <span className="grid w-4 shrink-0 place-items-center">
        {thread.status === "working" ? (
          <Spinner />
        ) : (
          <StatusDot status={thread.status} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {thread.title}
        <span className="ml-2.5 text-[12.5px] text-muted-foreground/70">
          {thread.ticketId}
          {ticket && ticket.title !== thread.title ? ` · ${ticket.title}` : ""}
        </span>
      </span>
      {byAgent && (
        <span className="flex w-[100px] shrink-0 items-center gap-2 text-[13.5px] text-muted-foreground">
          <Avatar name={who.name} tone={who.tone} size={18} />
          {who.name}
        </span>
      )}
      <span className="w-[96px] shrink-0">
        <StatusPill status={thread.status} />
      </span>
      <span className="w-11 shrink-0 text-right text-[13px] text-muted-foreground">
        {ago(thread.minutes)}
      </span>
    </RowButton>
  );
}
