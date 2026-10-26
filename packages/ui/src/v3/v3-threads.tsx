import {
  CalendarClockIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Btn, Page, Section, Tabs, Title, useTick } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { useFoldPrefs } from "./v3-layout-prefs";
import { AgentAvatar, CeoMark, DOT } from "./v3-marks";
import {
  asleepAgents,
  boardStatus,
  defaultAgent,
  LIVE_RANK,
  listedThreads,
  onLiveBoard,
  threadsIn,
  unseenThreads,
} from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ScheduledView } from "./v3-schedules";
import { sectionedThreads } from "./v3-sections";
import { IdleCard, ThreadCard } from "./v3-thread-card";
import {
  AgentThreadRow,
  ALL_GRID,
  AllRow,
  Fold,
  RecentRow,
  SettledRow,
  SnoozedRow,
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

function Summary({ data, threads }: { data: V3Data; threads: V3Thread[] }) {
  /* The same counts Home prints (D-#774). Zeros stay: this page is the
     board, and an empty board should say so. A parent waiting on helpers
     counts as working (D-#847). */
  const items: { status: V3Status; count: number; word: string }[] = [
    {
      status: "working",
      count: threads.filter((t) => boardStatus(data, t) === "working").length,
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
  /* Helpers have no card of their own (D-#847); the parent waiting on them
     lands in the working band. */
  const board = listedThreads(data.threads)
    .filter((t) => onLiveBoard(data, t))
    .sort(
      (a, b) =>
        (LIVE_RANK[boardStatus(data, a)] ?? 9) -
        (LIVE_RANK[boardStatus(data, b)] ?? 9),
    );
  // An agent with nothing on the board is asleep; its card says what wakes it.
  const asleep = asleepAgents(data);
  // Threads arrive newest first, so the head of the list is the newest.
  const finished = listedThreads(data.threads).filter(
    (t) => t.status === "done" && !t.unseen,
  );
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

/* Threads → All is the calm list (#862): what came back to you is on top
   (Pinned, then Active, newest-back first), work in progress folds away,
   and the Snoozed and Settled shelves sit folded at the bottom — the shape
   T3 Code's sidebar takes. */
function All(p: V3PageProps) {
  const { data } = p;
  /* A wake time passing quietly returns its thread to Active; tick so the
     list re-reads the clock without waiting for a touch. */
  useTick(30_000);
  // The Context column only exists when some thread reports its context.
  const hasContext = [...data.threads, ...(data.archivedThreads ?? [])].some(
    (t) => t.context !== undefined,
  );
  const s = sectionedThreads(data);
  const { folds, setFold } = useFoldPrefs();
  const row = (t: V3Thread) => (
    <AllRow key={t.id} {...p} t={t} hasContext={hasContext} />
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
      {s.pinned.length > 0 && (
        <>
          <div className="pt-2.5 pb-1 text-[12.5px] text-muted-foreground/70">
            Pinned
          </div>
          {s.pinned.map(row)}
          <div className="mt-2 border-[var(--v3-line)] border-b" />
        </>
      )}
      {s.active.map(row)}
      <Fold
        title="Working"
        count={s.working.length}
        open={folds.working === true}
        onToggle={(o) => setFold("working", o)}
      >
        {s.working.map(row)}
      </Fold>
      <Fold
        title="Snoozed"
        count={s.snoozed.length}
        open={folds.snoozed === true}
        onToggle={(o) => setFold("snoozed", o)}
      >
        {s.snoozed.map((t) => (
          <SnoozedRow key={t.id} {...p} t={t} />
        ))}
      </Fold>
      <Fold
        title="Settled"
        count={s.settled.length}
        open={folds.settled === true}
        onToggle={(o) => setFold("settled", o)}
      >
        <div data-settled-list>
          {s.settled.map((t) => (
            <SettledRow key={t.id} {...p} t={t} />
          ))}
        </div>
      </Fold>
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
                  {a.id === data.ceoId && <CeoMark />}
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
      {view !== "scheduled" && (
        <Summary data={data} threads={listedThreads(data.threads)} />
      )}
      {view === "live" && <Live {...props} />}
      {view === "all" && <All {...props} />}
      {view === "agent" && <ByAgent {...props} />}
      {view === "scheduled" && <ScheduledView {...props} />}
    </Page>
  );
}
