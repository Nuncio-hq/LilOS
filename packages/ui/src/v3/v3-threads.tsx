import {
  CalendarClockIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Btn, Page, Section, Tabs, Title } from "./v3-bits";
import { AgentAvatar, DOT } from "./v3-marks";
import {
  asleepAgents,
  defaultAgent,
  LIVE_RANK,
  onLiveBoard,
  threadsIn,
  unseenThreads,
} from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ScheduledView } from "./v3-schedules";
import { IdleCard, ThreadCard } from "./v3-thread-card";
import {
  AgentThreadRow,
  ALL_GRID,
  AllRow,
  Archived,
  RecentRow,
} from "./v3-threads-rows";
import type { V3Status, V3Thread } from "./v3-types";

type View = "live" | "all" | "agent" | "scheduled";

const TABS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "live", label: "Live", icon: <LayoutGridIcon /> },
  { id: "all", label: "All", icon: <ListIcon /> },
  { id: "agent", label: "By agent", icon: <TableIcon /> },
  { id: "scheduled", label: "Scheduled", icon: <CalendarClockIcon /> },
];

/** How many finished threads "Earlier today" lists; All has the rest. */
const EARLIER = 12;

function Summary({ threads }: { threads: V3Thread[] }) {
  /* The same counts Home prints (D-#774). Zeros stay: this page is the
     board, and an empty board should say so. */
  const items: { status: V3Status; count: number; word: string }[] = [
    {
      status: "working",
      count: threadsIn(threads, "working"),
      word: "working",
    },
    { status: "needs", count: threadsIn(threads, "needs"), word: "needs you" },
    { status: "stuck", count: threadsIn(threads, "stuck"), word: "stuck" },
    {
      status: "done",
      count: unseenThreads(threads).length,
      word: "finished, not seen",
    },
  ];
  return (
    <div className="mt-4 flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.word} className="inline-flex items-center gap-[7px]">
          <i
            className={cn(
              "inline-block size-[7px] rounded-full",
              DOT[i.status],
            )}
          />
          <b className="font-semibold text-foreground">{i.count}</b> {i.word}
        </span>
      ))}
    </div>
  );
}

function Live(p: V3PageProps) {
  const { data, go } = p;
  const board = data.threads
    .filter(onLiveBoard)
    .sort((a, b) => (LIVE_RANK[a.status] ?? 9) - (LIVE_RANK[b.status] ?? 9));
  // An agent with nothing on the board is asleep; its card says what wakes it.
  const asleep = asleepAgents(data);
  // Threads arrive newest first, so the head of the list is the newest.
  const finished = data.threads.filter((t) => t.status === "done" && !t.unseen);
  const earlier = finished.slice(0, EARLIER);

  return (
    <>
      {/* Cards reflow to the pane's width: three across alone, fewer when
          a record is open beside the list. */}
      <div className="mt-5 grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[860px]:grid-cols-3">
        {board.map((t) => (
          <ThreadCard key={t.id} t={t} {...p} />
        ))}
        {asleep.map((a) => (
          <IdleCard key={a.id} data={data} agent={a} go={go} />
        ))}
      </div>

      <Section
        title="Earlier today"
        count={finished.length}
        link="Open All"
        onLink={() => go({ page: "threads", view: "all" })}
      />
      <div className="border-[var(--v3-line)] border-t">
        {earlier.map((t) => (
          <RecentRow key={t.id} {...p} t={t} />
        ))}
      </div>
    </>
  );
}

function All(p: V3PageProps) {
  const { data } = p;
  // The Context column only exists when some thread reports its context.
  const hasContext = [...data.threads, ...(data.archivedThreads ?? [])].some(
    (t) => t.context !== undefined,
  );
  return (
    <div className="mt-5 text-[13.5px]">
      <div
        className={cn(
          "grid border-[var(--v3-line)] border-b pb-1.5 text-[12.5px] text-muted-foreground",
          hasContext ? ALL_GRID.context : ALL_GRID.plain,
        )}
      >
        <span>Thread</span>
        <span>Agent</span>
        <span>Status</span>
        <span className="hidden @min-[700px]:block">Started</span>
        <span className="hidden @min-[700px]:block">Took</span>
        {hasContext && (
          <span className="hidden @min-[700px]:block">Context</span>
        )}
        <span />
      </div>
      {data.threads.map((t) => (
        <AllRow key={t.id} {...p} t={t} hasContext={hasContext} />
      ))}
      <Archived
        {...p}
        threads={data.archivedThreads ?? []}
        hasContext={hasContext}
      />
    </div>
  );
}

function ByAgent(p: V3PageProps) {
  const { data, go } = p;
  return (
    <>
      {data.agents.map((a) => {
        const mine = data.threads.filter((t) => t.agentId === a.id);
        return (
          <div key={a.id}>
            <Section
              title={
                <span className="flex items-center gap-2">
                  <AgentAvatar data={data} agent={a} />
                  {a.name}
                  <span className="font-normal text-[13px] text-muted-foreground">
                    {a.role}
                  </span>
                </span>
              }
              count={mine.length}
              link="Open"
              onLink={() => go({ page: "agent", id: a.id })}
            />
            <div className="border-[var(--v3-line)] border-t">
              {mine.length === 0 && (
                <div className="border-[var(--v3-line)] border-b py-2.5 text-[13.5px] text-muted-foreground/70">
                  No threads yet.
                  {(a.next ?? a.schedule) && ` ${a.next ?? a.schedule}`}
                </div>
              )}
              {mine.map((t) => (
                <AgentThreadRow key={t.id} {...p} t={t} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function V3Threads(props: V3PageProps & { view: View }) {
  const { view, go, data } = props;
  const starter = defaultAgent(data);
  return (
    <Page wide>
      <Title>Threads</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Every agent thread, live.
      </p>
      <div className="flex items-end justify-between gap-4">
        <Tabs
          tabs={TABS}
          value={view}
          onChange={(v) => go({ page: "threads", view: v })}
        />
        {starter && (
          <Btn
            primary
            small
            onClick={() => go({ page: "newchat", id: starter.id })}
          >
            <PlusIcon /> New chat
          </Btn>
        )}
      </div>
      {view !== "scheduled" && <Summary threads={data.threads} />}
      {view === "live" && <Live {...props} />}
      {view === "all" && <All {...props} />}
      {view === "agent" && <ByAgent {...props} />}
      {view === "scheduled" && <ScheduledView {...props} />}
    </Page>
  );
}
