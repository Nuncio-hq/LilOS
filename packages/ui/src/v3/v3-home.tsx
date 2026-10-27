import { cn } from "../lib/utils";
import {
  ago,
  Btn,
  Meter,
  Page,
  relativeTime,
  Section,
  Title,
  useTick,
} from "./v3-bits";
import type { V3Ask, V3Data } from "./v3-data-types";
import { ChatDraft } from "./v3-draft-chat";
import { ThreadPill } from "./v3-live";
import { AgentAvatar, CeoMark, StatusDot, StatusPill } from "./v3-marks";
import {
  agentNameOf,
  agentOf,
  agentStatus,
  agentThread,
  agentTicket,
  askTag,
  asleepAgents,
  boardStatus,
  companyOn,
  defaultAgent,
  FORMER_AGENT,
  goalProgress,
  listedThreads,
  nextRunLabel,
  projectOf,
  resultsToLookAt,
  threadOf,
  threadsIn,
  ticketOf,
  waitingLabel,
} from "./v3-model";
import { RowButton, useOpenRoute } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { backThen, sectionedThreads } from "./v3-sections";
import { ThreadRow } from "./v3-threads-rows";
import type { V3Agent, V3Status } from "./v3-types";

/* Home: who is working, what needs you, what just finished. Counts are the
   Threads counts (D-#774). The CEO's note and Goals join with tickets (M2). */

const COUNT_ORDER: { status: V3Status; word: string }[] = [
  { status: "working", word: "working" },
  { status: "needs", word: "needs you" },
  /* Stuck counts the threads the harness marked (D-#772); like every count
     on the strip, a zero stays hidden. */
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

/** The thread counts on the strip: working / needs / stuck, a zero hidden
   (D-#774). With the company layer paused (D-#836) "idle" is left off too —
   it counts asleep *agents*, a fact the daily layout does not speak about. */
function CountStrip({
  data,
  team,
}: {
  data: V3Data;
  /** The company's roster ("N agents", "N outside workers", asleep idle). */
  team?: boolean;
}) {
  /* Helpers fold into their parent (D-#847): a parent waiting on them
     counts as working. */
  const listed = listedThreads(data.threads);
  const counts: Partial<Record<V3Status, number>> = {
    working: listed.filter((t) => boardStatus(data, t) === "working").length,
    needs: threadsIn(listed, "needs"),
    stuck: threadsIn(listed, "stuck"),
    idle: asleepAgents(data).length,
  };
  const outside = data.agents.filter((a) => a.kind === "outside").length;
  return (
    <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
      {team && (
        <span>
          <b className="font-semibold text-foreground">
            {data.agents.length - outside}
          </b>{" "}
          {data.agents.length - outside === 1 ? "agent" : "agents"}
        </span>
      )}
      {team && outside > 0 && (
        <span>
          <b className="font-semibold text-foreground">{outside}</b> outside{" "}
          {outside === 1 ? "worker" : "workers"}
        </span>
      )}
      {COUNT_ORDER.map(({ status, word }) =>
        counts[status] && (team || status !== "idle") ? (
          <span key={status} className="inline-flex items-center gap-[7px]">
            <StatusDot status={status} />
            <span>
              <b className="font-semibold text-foreground">{counts[status]}</b>{" "}
              {word}
            </span>
          </span>
        ) : null,
      )}
    </div>
  );
}

/** The Needs-you section, one row per ask — shared by both Home layouts. */
function NeedsBlock({ data, go, act }: V3PageProps) {
  return (
    <>
      <Section
        title="Needs you"
        count={data.asks.length}
        link="Open Needs you"
        onLink={() => go({ page: "needs" })}
      />
      {data.asks.length === 0 ? (
        <p className="border-[var(--v3-line)] border-y py-3.5 text-[14px] text-muted-foreground">
          Nothing needs you.
          {/* Only a real schedule (D-#19): the CEO's next scheduled run, if
              it has one — never a promised time nothing will keep. */}
          {data.ceoId &&
            nextRunLabel(data, data.ceoId) &&
            ` The CEO's next run: ${nextRunLabel(data, data.ceoId)}.`}
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
    </>
  );
}

/* The company-layer Home: the team, the CEO's note, results, goals. Drawn
   whenever `features.company` is on (it is on by default); when the layer
   is paused the daily layout below replaces it (D-#836). */
function CompanyHome({ data, go, act }: V3PageProps) {
  const rows = data.agents.map((a) => ({ agent: a, row: teamRow(data, a) }));
  const showWaiting = rows.some((r) => r.row.waiting !== "—");
  const grid = teamGrid(showWaiting);
  const results = resultsToLookAt(data);
  /* The latest note the CEO wrote. No CEO, no brief (D-#777). */
  const brief = data.ceoId
    ? [...data.updates]
        .filter((u) => u.by === data.ceoId)
        .sort((a, b) =>
          a.atSort !== undefined && b.atSort !== undefined
            ? b.atSort - a.atSort
            : b.at.localeCompare(a.at),
        )[0]
    : undefined;
  const briefBy = brief ? agentOf(data, brief.by) : undefined;

  return (
    <Page>
      <Title kicker={data.today}>Good afternoon, {data.me}</Title>

      <CountStrip data={data} team />

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

      <NeedsBlock data={data} go={go} act={act} />

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
                {a.id === data.ceoId && <CeoMark />}
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
                    {r.tag} · {r.by ? agentNameOf(data, r.by) : "Unassigned"}
                    {r.note && ` · ${r.note}`}
                  </div>
                </div>
                <span className="shrink-0 text-[13px] text-muted-foreground/70">
                  {relativeTime(r.minutes)}
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

/* Home with the company layer paused (D-#836): the counts, a box that talks
   to Hermes, the pinned threads, and one list under it — the daily app,
   with tickets, the team table, goals and the CEO's note out of sight but
   still in the data underneath. "Open Threads" goes to the list for the
   rest. */
const THREADS_HOME = 8;

/** A needs-you row in Home's list (#862): the ask's title, the pill and
    its quick action on the row, highlighted so it reads before the rest. */
function HomeAskRow({ data, ask, go, act }: V3PageProps & { ask: V3Ask }) {
  const t = ask.threadId ? threadOf(data, ask.threadId) : undefined;
  return (
    <RowButton
      opens={t ? { page: "thread", id: t.id } : undefined}
      onClick={() =>
        t ? go({ page: "thread", id: t.id }) : go({ page: "needs" })
      }
      className="flex min-h-[38px] items-center gap-2.5 rounded-md bg-orange-500/[0.07] px-2.5 py-1 text-[13.5px] dark:bg-orange-400/10"
    >
      <StatusDot status="needs" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span data-thread-title className="truncate text-foreground">
          {ask.title}
        </span>
        <ThreadPill status="needs" />
      </span>
      <span className="@min-[560px]:block hidden max-w-[38%] shrink truncate text-[12.5px] text-muted-foreground/70">
        {askTag(data, ask)} · {agentNameOf(data, ask.from)}
      </span>
      {/* The buttons act on the ask; the row itself opens where it lives. */}
      <span
        className="flex shrink-0 gap-1.5"
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
      </span>
    </RowButton>
  );
}

function DailyHome({ data, go, act }: V3PageProps) {
  const starter = defaultAgent(data);
  /* #886: one composer on screen — while a thread or a draft chat is open
     beside Home, the peek's box is the one and Home's steps aside (a
     project or agent record has no composer, so Home's stays). */
  const open = useOpenRoute();
  const composerBeside = open?.page === "thread" || open?.page === "newchat";
  /* A wake time passing quietly returns its thread — tick so Home re-reads
     the clock. */
  useTick(30_000);
  /* Home's list is one list (#862 feedback): what needs you first —
     highlighted, pill and quick action on the row — then work in flight,
     then the rest of what came back, newest first. Pinned keeps its own
     small block above; snoozed and settled sleep on their shelves and
     never land here. Helpers have no row (D-#847). Empty draws nothing. */
  const s = sectionedThreads(data);
  const now = Date.now();
  /* A thread with an open ask shows as the ask's highlighted row, not a
     thread row — the link runs both ways (a.threadId / t.askId). */
  const askIds = new Set(data.asks.map((a) => a.id));
  const asked = new Set(
    data.asks.map((a) => a.threadId).filter((x) => x !== undefined),
  );
  const recent = [
    ...s.working.filter((t) => !asked.has(t.id) && !askIds.has(t.askId ?? "")),
    ...s.active
      .filter((t) => !asked.has(t.id) && !askIds.has(t.askId ?? ""))
      .sort((a, b) => backThen(b, now) - backThen(a, now)),
  ];
  const rows = data.asks.length + recent.length;

  return (
    <Page>
      <Title kicker={data.today}>Good afternoon, {data.me}</Title>
      <CountStrip data={data} />
      {starter && !composerBeside && (
        <div className="mt-8">
          <ChatDraft
            key={starter.id}
            data={data}
            go={go}
            act={act}
            id={starter.id}
            fallback={starter}
            autoFocus={false}
          />
        </div>
      )}
      {s.pinned.length > 0 && (
        <>
          <Section title="Pinned" count={s.pinned.length} />
          <div className="border-[var(--v3-line)] border-t">
            {s.pinned.map((t) => (
              <ThreadRow key={t.id} data={data} t={t} go={go} act={act} />
            ))}
          </div>
        </>
      )}
      {rows > 0 && (
        <>
          <Section
            title="Threads"
            count={rows}
            link="Open Threads"
            onLink={() => go({ page: "threads" })}
          />
          <div className="flex flex-col gap-px">
            {data.asks.map((ask) => (
              <HomeAskRow
                key={ask.id}
                data={data}
                ask={ask}
                go={go}
                act={act}
              />
            ))}
            {recent
              .slice(0, Math.max(0, THREADS_HOME - data.asks.length))
              .map((t) => (
                <ThreadRow key={t.id} data={data} t={t} go={go} act={act} />
              ))}
          </div>
        </>
      )}
    </Page>
  );
}

export function V3Home(props: V3PageProps) {
  return companyOn(props.data) ? (
    <CompanyHome {...props} />
  ) : (
    <DailyHome {...props} />
  );
}
