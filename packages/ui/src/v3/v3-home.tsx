import { cn } from "../lib/utils";
import { ago, Btn, Meter, Page, Section, Title } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, StatusDot, StatusPill } from "./v3-marks";
import {
  agentNameOf,
  agentOf,
  agentStatus,
  agentThread,
  agentTicket,
  askTag,
  asleepAgents,
  FORMER_AGENT,
  goalProgress,
  nextRunLabel,
  projectOf,
  resultsToLookAt,
  threadsIn,
  ticketOf,
  waitingLabel,
} from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent, V3Status } from "./v3-types";

/* Home: who is working, what needs you, what just finished. Counts are the
   Threads counts (D-#774). The CEO's note and Goals join with tickets (M2). */

const COUNT_ORDER: { status: V3Status; word: string }[] = [
  { status: "working", word: "working" },
  { status: "needs", word: "needs you" },
  /* Stuck only when a thread already wears it. Nothing marks a thread stuck
     until that slice lands, so the count stays 0 and this row stays hidden. */
  { status: "stuck", word: "stuck" },
  { status: "idle", word: "idle" },
];

/* Beside an open record the team table keeps who, status and what they're
   on; since and waiting-on come back when the pane is wide enough. Waiting
   on is a ticket fact: with no ticket waiting, the column is not drawn. */
const teamGrid = (wait: boolean) =>
  cn(
    "grid grid-cols-[120px_110px_minmax(0,1fr)] items-center gap-x-3",
    wait
      ? "@min-[660px]:grid-cols-[150px_128px_minmax(0,1fr)_64px_96px]"
      : "@min-[660px]:grid-cols-[150px_128px_minmax(0,1fr)_64px]",
  );
const WIDE = "hidden @min-[660px]:block";

/** One team row: what the agent is on, since when, and who it waits on. */
function teamRow(d: V3Data, agent: V3Agent) {
  const agentId = agent.id;
  const status = agentStatus(d, agentId);
  const thread = agentThread(d, agentId);
  const idle = status === "idle";
  const ticket = idle
    ? agentTicket(d, agentId)
    : (ticketOf(d, thread?.ticketId ?? "") ?? agentTicket(d, agentId));
  /* An agent can work a hand on someone else's ticket (the CEO signing off
     Builder's HB-12); then the ticket's clock and blocker aren't its own. */
  const own = !idle && ticket?.owner === agentId;
  return {
    status,
    idle,
    text: idle
      ? (nextRunLabel(d, agentId) ?? agent.next ?? "Nothing assigned")
      : (thread?.title ?? ticket?.title ?? "—"),
    ticketId: ticket?.id,
    since:
      own && ticket
        ? ago(ticket.since)
        : !idle && thread
          ? ago(thread.minutes)
          : "—",
    late: status === "stuck",
    waiting: own && ticket ? waitingLabel(d, ticket) : "—",
  };
}

export function V3Home({ data, go, act }: V3PageProps) {
  /* Working and needs-you count threads, idle counts agents off the live
     board: the same numbers Threads shows (D-#774). A zero stays hidden. */
  const counts: Partial<Record<V3Status, number>> = {
    working: threadsIn(data.threads, "working"),
    needs: threadsIn(data.threads, "needs"),
    stuck: threadsIn(data.threads, "stuck"),
    idle: asleepAgents(data).length,
  };
  const rows = data.agents.map((a) => ({ agent: a, row: teamRow(data, a) }));
  const showWaiting = rows.some((r) => r.row.waiting !== "—");
  const grid = teamGrid(showWaiting);
  const results = resultsToLookAt(data);
  const outside = data.agents.filter((a) => a.kind === "outside").length;
  const brief = [...data.updates]
    .filter((u) => u.kind === "brief")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const briefBy = brief ? agentOf(data, brief.by) : undefined;

  return (
    <Page>
      <Title kicker={data.today}>Good afternoon, {data.me}</Title>

      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
        <span>
          <b className="font-semibold text-foreground">
            {data.agents.length - outside}
          </b>{" "}
          {data.agents.length - outside === 1 ? "agent" : "agents"}
        </span>
        {outside > 0 && (
          <span>
            <b className="font-semibold text-foreground">{outside}</b> outside{" "}
            {outside === 1 ? "worker" : "workers"}
          </span>
        )}
        {COUNT_ORDER.map(({ status, word }) =>
          counts[status] ? (
            <span key={status} className="inline-flex items-center gap-[7px]">
              <StatusDot status={status} />
              <span>
                <b className="font-semibold text-foreground">
                  {counts[status]}
                </b>{" "}
                {word}
              </span>
            </span>
          ) : null,
        )}
      </div>

      {brief && (
        <div className="mt-6 flex gap-3 rounded-[10px] bg-[var(--v3-soft)] px-[18px] py-4">
          <AgentAvatar
            data={data}
            agent={briefBy}
            size={24}
            className="mt-px"
          />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 text-[13.5px] text-muted-foreground">
              <span>
                <b className="font-semibold text-foreground">
                  {briefBy?.name ?? FORMER_AGENT}
                </b>{" "}
                · update at {brief.at}
              </span>
              <button
                type="button"
                onClick={() => go({ page: "inbox" })}
                className="ml-auto text-[13px] text-muted-foreground/70 hover:text-foreground"
              >
                All updates
              </button>
            </div>
            <p className="mt-[3px] text-[15px] leading-[1.6] text-foreground">
              {brief.text}
            </p>
          </div>
        </div>
      )}

      <Section
        title="Needs you"
        count={data.asks.length}
        link="Open Needs you"
        onLink={() => go({ page: "needs" })}
      />
      {data.asks.length === 0 ? (
        <p className="border-[var(--v3-line)] border-y py-3.5 text-[14px] text-muted-foreground">
          Nothing needs you.
          {data.ceoId && " The CEO will write at 15:00."}
        </p>
      ) : (
        <div className="border-[var(--v3-line)] border-t">
          {data.asks.map((ask) => (
            <RowButton
              key={ask.id}
              onClick={() => go({ page: "needs" })}
              className="flex min-h-[52px] items-center gap-3.5 border-[var(--v3-line)] border-b py-[7px]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">
                  {ask.title}
                </div>
                <div className="mt-px text-[13px] text-muted-foreground">
                  {askTag(data, ask)} · {agentNameOf(data, ask.from)} · waiting{" "}
                  {ago(ask.waiting)}
                </div>
              </div>
              {/* Buttons act on the ask; the row itself opens the full page. */}
              <div
                className="flex gap-2"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {ask.kind === "approval" ? (
                  <>
                    <Btn onClick={() => act.deny(ask.id)}>Deny</Btn>
                    <Btn primary onClick={() => act.approve(ask.id)}>
                      Approve
                    </Btn>
                  </>
                ) : (
                  <Btn onClick={() => go({ page: "needs" })}>Reply</Btn>
                )}
              </div>
            </RowButton>
          ))}
        </div>
      )}

      <Section
        title="Team"
        count={data.agents.length}
        link="Open People"
        onLink={() => go({ page: "people" })}
      />
      <div className="text-[14px]">
        <div
          className={cn(
            grid,
            "border-[var(--v3-line)] border-b pb-[7px] text-[12.5px] text-muted-foreground/70",
          )}
        >
          <span>Agent</span>
          <span>Status</span>
          <span>Working on</span>
          <span className={cn(WIDE, "text-right")}>Since</span>
          {showWaiting && (
            <span className={cn(WIDE, "text-right")}>Waiting on</span>
          )}
        </div>
        {rows.map(({ agent: a, row: r }) => {
          return (
            <RowButton
              key={a.id}
              opens={{ page: "agent", id: a.id }}
              onClick={() => go({ page: "agent", id: a.id })}
              className={cn(grid, "border-[var(--v3-line)] border-b py-2.5")}
            >
              <span className="flex items-center gap-[9px] font-medium text-foreground">
                <AgentAvatar data={data} agent={a} />
                {a.name}
              </span>
              <span>
                <StatusPill status={r.status} />
              </span>
              <span
                className={cn(
                  "truncate",
                  r.idle ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {r.text}
                {r.ticketId && (
                  <span className="text-muted-foreground/70">
                    {" "}
                    · {r.ticketId}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  WIDE,
                  "text-right",
                  r.late
                    ? "font-semibold text-red-600 dark:text-red-300"
                    : "text-muted-foreground",
                )}
              >
                {r.since}
              </span>
              {showWaiting && (
                <span
                  className={cn(
                    WIDE,
                    "text-right",
                    r.waiting === "—"
                      ? "text-muted-foreground/70"
                      : "text-foreground",
                  )}
                >
                  {r.waiting}
                </span>
              )}
            </RowButton>
          );
        })}
      </div>

      {/* Finished and not seen: the same rows Needs you lists (D-#774).
          Nothing finished stays hidden (D-#19). */}
      {results.length > 0 && (
        <>
          <Section title="Recent results" count={results.length} />
          <div className="border-[var(--v3-line)] border-t">
            {results.map((r) => (
              <RowButton
                key={r.key}
                opens={
                  r.threadId
                    ? { page: "thread", id: r.threadId }
                    : r.ticketId
                      ? { page: "ticket", id: r.ticketId }
                      : undefined
                }
                onClick={() => {
                  if (r.threadId) {
                    if (r.unseen) act.markSeen(r.threadId);
                    go({ page: "thread", id: r.threadId });
                  } else if (r.ticketId) go({ page: "ticket", id: r.ticketId });
                }}
                className="flex min-h-[52px] items-center gap-3.5 border-[var(--v3-line)] border-b py-[7px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">
                    {r.title}
                  </div>
                  <div className="mt-px truncate text-[13px] text-muted-foreground">
                    {r.tag} · {agentNameOf(data, r.by)}
                    {r.note && ` · ${r.note}`}
                  </div>
                </div>
                <span className="shrink-0 text-[13px] text-muted-foreground/70">
                  {r.minutes < 1 ? "just now" : `${ago(r.minutes)} ago`}
                </span>
              </RowButton>
            ))}
          </div>
        </>
      )}

      {/* Goals arrive with tickets (M2); until then nothing fake shows. */}
      {data.features.tickets && (
        <>
          <Section
            title="Goals"
            count={data.goals.length}
            link="Open Goals"
            onLink={() => go({ page: "goals" })}
          />
          <div className="border-[var(--v3-line)] border-t">
            {data.goals.map((g) => {
              const p = goalProgress(data, g.id);
              return (
                <RowButton
                  key={g.id}
                  onClick={() => go({ page: "goal", id: g.id })}
                  className="flex min-h-[54px] items-center gap-4 border-[var(--v3-line)] border-b py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {g.title}
                    </span>
                    <span className="block text-[13px] text-muted-foreground">
                      {projectOf(data, g.projectId)?.name} · due {g.due}
                    </span>
                  </span>
                  <Meter
                    value={p.total ? (p.done / p.total) * 100 : 0}
                    className="w-[150px]"
                  />
                  <span className="w-11 text-right text-[13px] text-muted-foreground">
                    {p.done} / {p.total}
                  </span>
                </RowButton>
              );
            })}
          </div>
        </>
      )}
    </Page>
  );
}
