import { CalendarClockIcon, ListIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Btn, Page, Tabs, Title, useTick } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import {
  type ThreadGroup,
  useFoldPrefs,
  useThreadGroupPref,
} from "./v3-layout-prefs";
import { AgentAvatar, CeoMark, DOT, ProjectMark } from "./v3-marks";
import {
  boardStatus,
  defaultAgent,
  listedThreads,
  threadProjectId,
  threadsIn,
  unseenThreads,
} from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ScheduledView } from "./v3-schedules";
import { sectionedThreads } from "./v3-sections";
import { Fold, ThreadRow } from "./v3-threads-rows";
import type { V3Status, V3Thread } from "./v3-types";

/* Threads is one list now (#862 feedback): the card board and the table
   collapsed into a single list that's easy to scan — Pinned, then what
   came back to you (Active, newest-back first), work in progress folded
   away, and the Snoozed and Settled shelves folded at the bottom.
   Scheduled keeps its own tab; "Group by" re-sorts the same list by
   section (the default), agent or project — the Settled shelf stays a
   shelf whatever the grouping. */

const TABS: { id: "threads" | "scheduled"; label: string; icon: ReactNode }[] =
  [
    { id: "threads", label: "Threads", icon: <ListIcon /> },
    { id: "scheduled", label: "Scheduled", icon: <CalendarClockIcon /> },
  ];

const GROUPS: { id: ThreadGroup; label: string }[] = [
  { id: "section", label: "Section" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "Project" },
];

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
    <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13.5px] text-muted-foreground">
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

/* The grouping switch: Section (the shelves) is the default; Agent and
   Project re-sort the same rows under roster heads. The choice is a
   device-local view preference, not thread state. */
function GroupBy({
  group,
  onGroup,
}: {
  group: ThreadGroup;
  onGroup: (group: ThreadGroup) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      Group by:
      <span
        role="radiogroup"
        aria-label="Group threads by"
        className="flex rounded-lg bg-[var(--v3-soft)] p-0.5"
      >
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="radio"
            aria-checked={group === g.id}
            onClick={() => onGroup(g.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
              group === g.id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {g.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function ThreadList(p: V3PageProps & { group: ThreadGroup }) {
  const { data, group } = p;
  /* A wake time passing quietly returns its thread to Active; tick so the
     list re-reads the clock without waiting for a touch. */
  useTick(30_000);
  const s = sectionedThreads(data);
  const { folds, setFold } = useFoldPrefs();
  const row = (t: V3Thread, drop?: "project" | "agent") => (
    <ThreadRow key={t.id} {...p} t={t} drop={drop} />
  );
  /* Settled keeps its shelf in every grouping: it's where finished work
     goes, not a status. */
  const settled = (
    <Fold
      title="Settled"
      count={s.settled.length}
      open={folds.settled === true}
      onToggle={(o) => setFold("settled", o)}
      marker="settled"
    >
      <div data-settled-list>
        {s.settled.map((t) => (
          <ThreadRow key={t.id} {...p} t={t} settled />
        ))}
      </div>
    </Fold>
  );

  if (group === "section")
    return (
      <div className="mt-3 text-[13.5px]">
        {s.pinned.length > 0 && (
          <>
            <div className="pt-1 pb-1 text-[12.5px] text-muted-foreground/70">
              Pinned
            </div>
            {s.pinned.map((t) => row(t))}
          </>
        )}
        {s.active.length > 0 && (
          <>
            <div className="pt-2.5 pb-1 text-[12.5px] text-muted-foreground/70">
              Active
            </div>
            {s.active.map((t) => row(t))}
          </>
        )}
        <Fold
          title="Working"
          count={s.working.length}
          open={folds.working === true}
          onToggle={(o) => setFold("working", o)}
          marker="working"
        >
          {s.working.map((t) => row(t))}
        </Fold>
        <Fold
          title="Snoozed"
          count={s.snoozed.length}
          open={folds.snoozed === true}
          onToggle={(o) => setFold("snoozed", o)}
          marker="snoozed"
        >
          {s.snoozed.map((t) => row(t))}
        </Fold>
        {settled}
      </div>
    );

  /* Agent and Project groupings carry the same rows in the same order —
     Pinned's threads still lead their group — under roster heads that fold
     like the shelves. */
  const pool = [...s.pinned, ...s.active, ...s.working, ...s.snoozed];
  if (group === "agent")
    return (
      <div className="mt-1 text-[13.5px]">
        {data.agents
          .map((a) => ({
            a,
            threads: pool.filter((t) => t.agentId === a.id),
          }))
          .filter((g) => g.threads.length > 0)
          .map(({ a, threads }) => (
            <Fold
              key={a.id}
              marker={`agent:${a.id}`}
              title={
                <span className="inline-flex items-center gap-2">
                  <AgentAvatar data={data} agent={a} />
                  {a.name}
                  {a.id === data.ceoId && <CeoMark />}
                  <span className="font-normal text-[13px] text-muted-foreground">
                    {a.role}
                  </span>
                </span>
              }
              count={threads.length}
              open={folds[`agent:${a.id}`] !== false}
              onToggle={(o) => setFold(`agent:${a.id}`, o)}
            >
              {threads.map((t) => row(t, "agent"))}
            </Fold>
          ))}
        {settled}
      </div>
    );

  const groups = data.projects
    .map((pr) => ({
      pr,
      threads: pool.filter((t) => threadProjectId(data, t) === pr.id),
    }))
    .filter((g) => g.threads.length > 0);
  const chats = pool.filter((t) => threadProjectId(data, t) === undefined);
  return (
    <div className="mt-1 text-[13.5px]">
      {groups.map(({ pr, threads }) => (
        <Fold
          key={pr.id}
          marker={`project:${pr.id}`}
          title={
            <span className="inline-flex items-center gap-2">
              <ProjectMark name={pr.name} tone={pr.tone} />
              {pr.name}
            </span>
          }
          count={threads.length}
          open={folds[`project:${pr.id}`] !== false}
          onToggle={(o) => setFold(`project:${pr.id}`, o)}
        >
          {threads.map((t) => row(t, "project"))}
        </Fold>
      ))}
      {chats.length > 0 && (
        <Fold
          title="Chats"
          count={chats.length}
          open={folds["project:chats"] !== false}
          onToggle={(o) => setFold("project:chats", o)}
          marker="project:chats"
        >
          {chats.map((t) => row(t))}
        </Fold>
      )}
      {settled}
    </div>
  );
}

export function V3Threads(props: V3PageProps & { view?: "scheduled" }) {
  const { view, go, data } = props;
  const scheduled = view === "scheduled";
  const starter = defaultAgent(data);
  const { group, setGroup } = useThreadGroupPref();
  return (
    <Page wide>
      <Title>Threads</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Every agent thread, live.
      </p>
      <div className="flex items-end justify-between gap-4">
        <Tabs
          tabs={TABS}
          value={scheduled ? "scheduled" : "threads"}
          onChange={(v) =>
            go({
              page: "threads",
              view: v === "scheduled" ? "scheduled" : undefined,
            })
          }
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
      {!scheduled && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Summary data={data} threads={listedThreads(data.threads)} />
          <GroupBy group={group} onGroup={setGroup} />
        </div>
      )}
      {!scheduled && <ThreadList {...props} group={group} />}
      {scheduled && <ScheduledView {...props} />}
    </Page>
  );
}
