import { cn } from "../lib/utils";
import {
  AgentAvatar,
  ago,
  Btn,
  Meter,
  Page,
  RowButton,
  Section,
  StatusDot,
  StatusPill,
  Title,
} from "./v3-bits";
import {
  agentNameOf,
  agentOf,
  agentStatus,
  agentThread,
  agentTicket,
  FORMER_AGENT,
  goalProgress,
  projectOf,
  teamCounts,
  ticketOf,
  waitingLabel,
} from "./v3-model";
import type { V3Agent, V3Data, V3PageProps, V3Status } from "./v3-types";

/* Home: three quiet answers on one page. What do I have to do, how is the
   team, how far are the goals. The CEO's note sits on top like a morning
   briefing. */

const COUNT_ORDER: { status: V3Status; word: string }[] = [
  { status: "working", word: "working" },
  { status: "waiting", word: "waiting" },
  { status: "needs", word: "needs you" },
  { status: "stuck", word: "stuck" },
  { status: "idle", word: "idle" },
];

/* Beside an open record the team table keeps who, status and what they're
   on; since and waiting-on come back when the pane is wide enough. */
const TEAM_GRID =
  "grid grid-cols-[120px_110px_minmax(0,1fr)] @min-[660px]:grid-cols-[150px_128px_minmax(0,1fr)_64px_96px] items-center gap-x-3";
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
      ? (agent.next ?? "Nothing assigned")
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
  const counts = teamCounts(data);
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
                  {ask.ticketId ?? "Chat"} · {agentNameOf(data, ask.from)} ·
                  waiting {ago(ask.waiting)}
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
            TEAM_GRID,
            "border-[var(--v3-line)] border-b pb-[7px] text-[12.5px] text-muted-foreground/70",
          )}
        >
          <span>Agent</span>
          <span>Status</span>
          <span>Working on</span>
          <span className={cn(WIDE, "text-right")}>Since</span>
          <span className={cn(WIDE, "text-right")}>Waiting on</span>
        </div>
        {data.agents.map((a) => {
          const r = teamRow(data, a);
          return (
            <RowButton
              key={a.id}
              opens={{ page: "agent", id: a.id }}
              onClick={() => go({ page: "agent", id: a.id })}
              className={cn(
                TEAM_GRID,
                "border-[var(--v3-line)] border-b py-2.5",
              )}
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
            </RowButton>
          );
        })}
      </div>

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
