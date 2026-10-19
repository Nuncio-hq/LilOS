import { LayoutGridIcon, ListIcon, PlusIcon, TableIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  Avatar,
  Btn,
  DOT,
  Meter,
  Page,
  RowButton,
  Section,
  span,
  Tabs,
  TicketId,
  Title,
} from "./v3-bits";
import { ThreadPill } from "./v3-live";
import { agentOf } from "./v3-model";
import { IdleCard, ThreadCard } from "./v3-thread-card";
import type { V3PageProps, V3Status, V3Thread } from "./v3-types";

type View = "live" | "all" | "agent";

const TABS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "live", label: "Live", icon: <LayoutGridIcon /> },
  { id: "all", label: "All", icon: <ListIcon /> },
  { id: "agent", label: "By agent", icon: <TableIcon /> },
];

/** Live board order: what needs a person first. */
const RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  working: 2,
  done: 3,
};

function Summary({ threads }: { threads: V3Thread[] }) {
  const n = (s: V3Status) => threads.filter((t) => t.status === s).length;
  const items: { status: V3Status; count: number; word: string }[] = [
    { status: "working", count: n("working"), word: "working" },
    { status: "needs", count: n("needs"), word: "needs you" },
    { status: "stuck", count: n("stuck"), word: "stuck" },
    {
      status: "done",
      count: threads.filter((t) => t.status === "done" && t.unseen).length,
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
    .filter((t) => t.status in RANK && (t.status !== "done" || t.unseen))
    .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  // An agent with nothing on the board is asleep; its card says what wakes it.
  const asleep = data.agents.filter(
    (a) => !board.some((t) => t.agentId === a.id),
  );
  const earlier = data.threads.filter((t) => t.status === "done" && !t.unseen);

  return (
    <>
      {/* Cards reflow to the pane's width: three across alone, fewer when
          a record is open beside the list. */}
      <div className="mt-5 grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[860px]:grid-cols-3">
        {board.map((t) => (
          <ThreadCard key={t.id} t={t} {...p} />
        ))}
        {asleep.map((a) => (
          <IdleCard key={a.id} agent={a} go={go} />
        ))}
      </div>

      <Section
        title="Earlier today"
        count={earlier.length}
        link="Open All"
        onLink={() => go({ page: "threads", view: "all" })}
      />
      <div className="border-[var(--v3-line)] border-t">
        {earlier.map((t) => {
          const a = agentOf(data, t.agentId);
          return (
            <RowButton
              key={t.id}
              opens={{ page: "thread", id: t.id }}
              onClick={() => go({ page: "thread", id: t.id })}
              className="grid grid-cols-[minmax(0,1fr)_130px_minmax(0,170px)_70px] items-center gap-4 border-[var(--v3-line)] border-b py-2.5 text-[13.5px]"
            >
              <span className="truncate">
                <TicketId id={t.ticketId ?? "Chat"} />
                {t.title}
              </span>
              <span className="flex items-center gap-2">
                <Avatar name={a.name} tone={a.tone} />
                {a.name}
              </span>
              <span className="truncate text-muted-foreground">
                {t.summary}
              </span>
              <span className="text-right text-muted-foreground">
                {span(t.minutes)}
              </span>
            </RowButton>
          );
        })}
      </div>
    </>
  );
}

const COLS = "grid-cols-[minmax(0,1fr)_120px_100px_70px_70px_100px]";

function All({ data, go }: V3PageProps) {
  return (
    <div className="mt-5 text-[13.5px]">
      <div
        className={cn(
          "grid gap-4 border-[var(--v3-line)] border-b pb-1.5 text-[12.5px] text-muted-foreground",
          COLS,
        )}
      >
        <span>Thread</span>
        <span>Agent</span>
        <span>Status</span>
        <span>Started</span>
        <span>Took</span>
        <span>Context</span>
      </div>
      {data.threads.map((t) => {
        const a = agentOf(data, t.agentId);
        return (
          <RowButton
            key={t.id}
            opens={{ page: "thread", id: t.id }}
            onClick={() => go({ page: "thread", id: t.id })}
            className={cn(
              "grid items-center gap-4 border-[var(--v3-line)] border-b py-2.5",
              COLS,
            )}
          >
            <span className="truncate">
              <TicketId id={t.ticketId ?? "Chat"} />
              {t.title}
            </span>
            <span className="flex items-center gap-2">
              <Avatar name={a.name} tone={a.tone} />
              {a.name}
            </span>
            <span>
              <ThreadPill status={t.status} />
            </span>
            <span className="text-muted-foreground">{t.startedAt}</span>
            <span className="text-muted-foreground">{span(t.minutes)}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <Meter value={t.context} className="w-10" />
              {t.context}%
            </span>
          </RowButton>
        );
      })}
    </div>
  );
}

function ByAgent({ data, go }: V3PageProps) {
  return (
    <>
      {data.agents.map((a) => {
        const mine = data.threads.filter((t) => t.agentId === a.id);
        return (
          <div key={a.id}>
            <Section
              title={
                <span className="flex items-center gap-2">
                  <Avatar name={a.name} tone={a.tone} />
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
                  No threads yet. {a.next ?? a.schedule}
                </div>
              )}
              {mine.map((t) => (
                <RowButton
                  key={t.id}
                  opens={{ page: "thread", id: t.id }}
                  onClick={() => go({ page: "thread", id: t.id })}
                  className="flex items-center gap-4 border-[var(--v3-line)] border-b py-2 text-[13.5px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <TicketId id={t.ticketId ?? "Chat"} />
                    {t.title}
                  </span>
                  <ThreadPill status={t.status} />
                  <span className="w-12 text-right text-muted-foreground">
                    {span(t.minutes)}
                  </span>
                  <span className="w-20 text-right text-muted-foreground/70">
                    {t.startedAt}
                  </span>
                </RowButton>
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
  return (
    <Page wide>
      <Title>Threads</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Every agent session, live.
      </p>
      <div className="flex items-end justify-between gap-4">
        <Tabs
          tabs={TABS}
          value={view}
          onChange={(v) => go({ page: "threads", view: v })}
        />
        <Btn primary small onClick={() => go({ page: "chat" })}>
          <PlusIcon /> New chat
        </Btn>
      </div>
      <Summary threads={data.threads} />
      {view === "live" && <Live {...props} />}
      {view === "all" && <All {...props} />}
      {view === "agent" && <ByAgent {...props} />}
    </Page>
  );
}
