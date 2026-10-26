import { cn } from "../lib/utils";
import { ago, Spinner, TicketId } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { HelpersHint } from "./v3-helpers";
import { AgentAvatar, CeoMark, StatusDot, StatusPill } from "./v3-marks";
import {
  agentOf,
  boardStatus,
  companyOn,
  FORMER_AGENT,
  listedAncestorOf,
  threadOf,
  threadTag,
  ticketOf,
} from "./v3-model";
import { RowButton, useOpenRoute } from "./v3-open-record";
import type { V3Route } from "./v3-page-types";
import type { V3Agent, V3ConnectorDef, V3Thread, V3Ticket } from "./v3-types";

/* Rows shared by the goal, project and agent pages: the same ticket or
   thread always looks the same wherever it is listed. */

/** The connector an outside worker is reached through; none for a LilOS agent
   or for an agent that is gone. */
export const viaOf = (
  d: V3Data,
  a: V3Agent | undefined,
): V3ConnectorDef | undefined =>
  a?.kind === "outside" ? d.connectors.find((c) => c.id === a.via) : undefined;

/** An agent's face and name (FORMER_AGENT once it is gone); an outside worker
   also says which connector it is reached through, tiny and muted, only when
   the pane is wide enough. */
export function AgentName({
  data,
  agent,
  size,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  size?: number;
}) {
  const via = viaOf(data, agent);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentAvatar data={data} agent={agent} size={size} />
      <span className="truncate">
        {agent?.name ?? FORMER_AGENT}
        {via && (
          <span className="ml-1.5 hidden text-[11.5px] text-muted-foreground/70 @min-[680px]:inline">
            via {via.label}
          </span>
        )}
      </span>
      {agent?.id === data.ceoId && <CeoMark />}
    </span>
  );
}

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
  const who = ticket.owner ? agentOf(data, ticket.owner) : undefined;
  return (
    <RowButton
      opens={{ page: "ticket", id: ticket.id }}
      onClick={() => go({ page: "ticket", id: ticket.id })}
      className="flex min-h-[40px] items-center gap-3 border-[var(--v3-line)] border-b py-1.5 text-[14px]"
    >
      <span className="min-w-0 flex-1 truncate text-foreground">
        <TicketId id={ticket.id} />
        {ticket.title}
      </span>
      {owner && (
        <span className="flex w-[148px] shrink-0 items-center gap-1.5 text-[13.5px] text-muted-foreground">
          {ticket.owner && <AgentAvatar data={data} agent={who} size={18} />}
          <span className="truncate">
            {ticket.owner ? (who?.name ?? FORMER_AGENT) : "Unassigned"}
          </span>
          {who?.id === data.ceoId && <CeoMark />}
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
  inProject,
}: {
  data: V3Data;
  thread: V3Thread;
  go: (r: V3Route) => void;
  /** Name the agent instead of the ticket's owner-less context. */
  byAgent?: boolean;
  /** Listed on its own project's page: the page already says the project, so
     only a ticket tags the row. */
  inProject?: boolean;
}) {
  const who = agentOf(data, thread.agentId);
  const ticket =
    thread.ticketId && companyOn(data)
      ? ticketOf(data, thread.ticketId)
      : undefined;
  /* With the company layer paused (D-#836) a ticket id names nothing the
     daily app can show, so an in-project row carries no tag. */
  const tag = inProject
    ? companyOn(data)
      ? thread.ticketId
      : undefined
    : threadTag(data, thread);
  /* A helper row appears only on agent-scoped lists: it names its parent.
     An open helper marks its nearest listed ancestor's row (D-#847). */
  const parent = thread.parentId ? threadOf(data, thread.parentId) : undefined;
  const open = useOpenRoute();
  return (
    <RowButton
      opens={{ page: "thread", id: thread.id }}
      marked={
        open?.page === "thread" && listedAncestorOf(data, open.id) === thread.id
      }
      onClick={() => go({ page: "thread", id: thread.id })}
      className="flex min-h-[40px] items-center gap-3 border-[var(--v3-line)] border-b py-1.5 text-[14px]"
    >
      <span className="grid w-4 shrink-0 place-items-center">
        {boardStatus(data, thread) === "working" ? (
          <Spinner />
        ) : (
          <StatusDot status={thread.status} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {thread.title}
        {tag && (
          <span className="ml-2.5 text-[12.5px] text-muted-foreground/70">
            {tag}
            {ticket && ticket.title !== thread.title
              ? ` · ${ticket.title}`
              : ""}
          </span>
        )}
        {parent && (
          <span className="ml-2.5 text-[12.5px] text-muted-foreground/70">
            helper of {parent.title}
          </span>
        )}
      </span>
      <HelpersHint data={data} thread={thread} />
      {byAgent && (
        <span className="w-[100px] shrink-0 text-[13.5px] text-muted-foreground @min-[680px]:w-[170px]">
          <AgentName data={data} agent={who} size={18} />
        </span>
      )}
      <span className="w-[96px] shrink-0">
        {/* A parent waiting on helpers reads as Working (D-#847). */}
        <StatusPill status={boardStatus(data, thread)} />
      </span>
      <span className="w-11 shrink-0 text-right text-[13px] text-muted-foreground">
        {ago(thread.minutes)}
      </span>
    </RowButton>
  );
}
