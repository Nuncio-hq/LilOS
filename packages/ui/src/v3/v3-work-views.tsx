import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import {
  AgentAvatar,
  ago,
  INK,
  ProjectMark,
  RowButton,
  StatusDot,
  StatusPill,
  TicketId,
  useOpenRecord,
} from "./v3-bits";
import { agentOf, projectOf } from "./v3-model";
import type { V3Data, V3Route, V3Status, V3Ticket } from "./v3-types";

/* The three table-like Work views: Waiting on, Board, By project. They share
   one row anatomy: who holds it, what state, since when, what it waits on. */

export type WorkViewProps = {
  data: V3Data;
  go: (route: V3Route) => void;
  /** Already narrowed by the project filter. */
  tickets: V3Ticket[];
};

/* Minutes in the current status (done tickets count from when they finished);
   stuck for over half an hour is the one number that turns red. */
function Since({ t }: { t: V3Ticket }) {
  if (t.status === "planned")
    return <span className="text-right text-muted-foreground/70">—</span>;
  const late = t.status === "stuck" && t.since > 30;
  return (
    <span
      className={cn(
        "text-right",
        late ? cn("font-semibold", INK.stuck) : "text-muted-foreground",
      )}
    >
      {ago(t.status === "done" ? (t.doneAgo ?? 0) : t.since)}
    </span>
  );
}

export function Who({ data, id }: { data: V3Data; id: string }) {
  const a = agentOf(data, id);
  return (
    <span className="flex min-w-0 items-center gap-2 font-medium">
      <AgentAvatar data={data} agent={a} />
      <span className="truncate">{a.name}</span>
    </span>
  );
}

const Triangle = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 10 10"
    aria-hidden
    className={cn(
      "size-2.5 fill-muted-foreground/60 transition-transform",
      !open && "-rotate-90",
    )}
  >
    <path d="M1 3h8L5 8z" />
  </svg>
);

/* ───────────── Waiting on ───────────── */

/* Beside an open record the table keeps the ticket, its status and how long;
   owner and project come back when the pane is wide enough. */
const COLS =
  "grid grid-cols-[minmax(0,1fr)_118px_56px] @min-[680px]:grid-cols-[minmax(0,1fr)_132px_112px_118px_56px] items-center gap-x-3";
const WIDE = "hidden @min-[680px]:block";

type Group = {
  key: string;
  label: string;
  status: V3Status;
  rows: V3Ticket[];
  folded?: boolean;
  /** The quiet phrase after a title: why it waits, why it is stuck. */
  note: (t: V3Ticket) => ReactNode;
};

/** Group tickets by what each one is waiting on; empty groups drop out. */
function groupTickets(data: V3Data, tickets: V3Ticket[]): Group[] {
  const none = () => null;
  const groups: Group[] = [];
  const you = tickets.filter(
    (t) => t.status === "needs" || t.waitingOn?.kind === "you",
  );
  groups.push({
    key: "you",
    label: "Waiting on you",
    status: "needs",
    rows: you,
    note: none,
  });

  const waiting = tickets.filter(
    (t) => t.status === "waiting" && !you.includes(t),
  );
  const byAgent = new Map<string, V3Ticket[]>();
  for (const t of waiting) {
    if (t.waitingOn?.kind !== "agent") continue;
    byAgent.set(t.waitingOn.agentId, [
      ...(byAgent.get(t.waitingOn.agentId) ?? []),
      t,
    ]);
  }
  for (const [agentId, rows] of byAgent) {
    const a = agentOf(data, agentId);
    groups.push({
      key: `agent-${agentId}`,
      label: `Waiting on ${agentId === data.ceoId ? "the CEO" : a.name}`,
      status: "waiting",
      rows,
      note: (t) => (t.waitingOn?.kind === "agent" ? t.waitingOn.why : null),
    });
  }
  groups.push({
    key: "ticket",
    label: "Waiting on another ticket",
    status: "waiting",
    rows: waiting.filter((t) => t.waitingOn?.kind === "ticket"),
    note: (t) =>
      t.waitingOn?.kind === "ticket" ? `after ${t.waitingOn.ticketId}` : null,
  });
  groups.push({
    key: "other",
    label: "Waiting",
    status: "waiting",
    rows: waiting.filter((t) => !t.waitingOn),
    note: none,
  });
  groups.push({
    key: "stuck",
    label: "Not moving",
    status: "stuck",
    rows: tickets.filter((t) => t.status === "stuck" || t.status === "failed"),
    note: (t) => (
      <span className={cn(INK.stuck, "opacity-80")}>{t.stuckWhy}</span>
    ),
  });
  groups.push({
    key: "moving",
    label: "Moving",
    status: "working",
    rows: tickets.filter((t) => t.status === "working"),
    note: none,
  });
  groups.push({
    key: "scheduled",
    label: "Scheduled",
    status: "planned",
    rows: tickets.filter((t) => t.status === "planned"),
    note: (t) => (t.startsAt ? `starts ${t.startsAt}` : null),
  });
  groups.push({
    key: "done",
    label: "Done today",
    status: "done",
    rows: tickets.filter((t) => t.status === "done" && (t.doneAgo ?? 0) < 1440),
    folded: true,
    note: none,
  });
  return groups.filter((g) => g.rows.length > 0);
}

export function WaitingView({ data, go, tickets }: WorkViewProps) {
  const groups = groupTickets(data, tickets);
  // Groups the reader has flipped; absent = the group's own default.
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  if (groups.length === 0) return <Empty />;

  return (
    <div className="mt-2">
      <div
        className={cn(
          COLS,
          "-mx-2 border-[var(--v3-line)] border-b px-2 pt-3 pb-[7px] text-[12.5px] text-muted-foreground/70",
        )}
      >
        <span>Ticket</span>
        <span className={WIDE}>Owner</span>
        <span className={WIDE}>Project</span>
        <span>Status</span>
        <span className="text-right">Since</span>
      </div>
      {groups.map((g) => {
        const open = g.folded ? !!flipped[g.key] : !flipped[g.key];
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => setFlipped((f) => ({ ...f, [g.key]: !f[g.key] }))}
              className="flex items-center gap-2 pt-6 pb-1.5"
            >
              <Triangle open={open} />
              <StatusPill status={g.status} label={g.label} />
              <small className="text-[13px] text-muted-foreground/70">
                {g.rows.length}
              </small>
            </button>
            {open &&
              g.rows.map((t) => {
                const note = g.note(t);
                return (
                  <RowButton
                    key={t.id}
                    opens={{ page: "ticket", id: t.id }}
                    onClick={() => go({ page: "ticket", id: t.id })}
                    className={cn(
                      COLS,
                      "min-h-[41px] rounded-none border-[var(--v3-line)] border-b py-2.5 text-[14px]",
                    )}
                  >
                    <span className="truncate">
                      <TicketId id={t.id} />
                      {t.title}
                      {note && (
                        <span className="text-muted-foreground/70">
                          {" "}
                          · {note}
                        </span>
                      )}
                    </span>
                    <span className={WIDE}>
                      <Who data={data} id={t.owner} />
                    </span>
                    <span
                      className={cn(WIDE, "truncate text-muted-foreground")}
                    >
                      {projectOf(data, t.projectId)?.name}
                    </span>
                    <StatusPill
                      status={t.status}
                      className="justify-self-start"
                    />
                    <Since t={t} />
                  </RowButton>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

const Empty = () => (
  <p className="mt-10 text-center text-[14px] text-muted-foreground">
    No tickets here.
  </p>
);

/* ───────────── Board ───────────── */

const COLUMNS: {
  label: string;
  status: V3Status;
  match: (t: V3Ticket) => boolean;
}[] = [
  { label: "Needs you", status: "needs", match: (t) => t.status === "needs" },
  {
    label: "Stuck",
    status: "stuck",
    match: (t) => t.status === "stuck" || t.status === "failed",
  },
  { label: "Waiting", status: "waiting", match: (t) => t.status === "waiting" },
  { label: "Working", status: "working", match: (t) => t.status === "working" },
  { label: "Planned", status: "planned", match: (t) => t.status === "planned" },
  {
    label: "Done",
    status: "done",
    match: (t) => t.status === "done" && (t.doneAgo ?? 0) < 1440,
  },
];

export function BoardView({ data, go, tickets }: WorkViewProps) {
  const isOpen = useOpenRecord();
  return (
    <div className="mt-6 flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((c) => {
        const rows = tickets.filter(c.match);
        return (
          <div key={c.label} className="w-[172px] shrink-0">
            <div className="mb-2 flex items-center gap-2 px-0.5 text-[13px] font-medium">
              <StatusDot status={c.status} />
              {c.label}
              <small className="font-normal text-muted-foreground/70">
                {rows.length}
              </small>
            </div>
            <div className="flex flex-col gap-2">
              {rows.map((t) => {
                const owner = agentOf(data, t.owner);
                return (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => go({ page: "ticket", id: t.id })}
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border border-[var(--v3-line)] p-2.5 text-left transition-colors hover:bg-[var(--v3-hover)]",
                      isOpen("ticket", t.id) &&
                        "border-foreground/45 bg-[var(--v3-hover)]",
                    )}
                  >
                    <span className="text-[12px] text-muted-foreground/70">
                      {t.id}
                    </span>
                    <span className="text-[13.5px] leading-snug">
                      {t.title}
                    </span>
                    <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                      <AgentAvatar data={data} agent={owner} size={18} />
                      <span className="truncate">{owner.name}</span>
                      <span
                        className={cn(
                          "ml-auto shrink-0",
                          t.status === "stuck" && t.since > 30
                            ? cn("font-semibold", INK.stuck)
                            : "text-muted-foreground/70",
                        )}
                      >
                        {t.status === "planned"
                          ? (t.startsAt ?? "—")
                          : ago(
                              t.status === "done" ? (t.doneAgo ?? 0) : t.since,
                            )}
                      </span>
                    </span>
                  </button>
                );
              })}
              {rows.length === 0 && (
                <div className="rounded-lg border border-[var(--v3-line)] border-dashed px-2.5 py-3 text-center text-[12.5px] text-muted-foreground/70">
                  Nothing
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── By project ───────────── */

const OPEN_ORDER: V3Status[] = [
  "needs",
  "stuck",
  "failed",
  "working",
  "waiting",
  "planned",
];
const PCOLS =
  "grid grid-cols-[minmax(0,1fr)_118px_56px] @min-[680px]:grid-cols-[minmax(0,1fr)_132px_118px_56px] items-center gap-x-3";

export function ProjectView({ data, go, tickets }: WorkViewProps) {
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const projects = data.projects.filter((p) =>
    tickets.some((t) => t.projectId === p.id),
  );
  if (projects.length === 0) return <Empty />;

  return (
    <div>
      {projects.map((p) => {
        const mine = tickets.filter((t) => t.projectId === p.id);
        const open = mine
          .filter((t) => t.status !== "done")
          .sort(
            (a, b) =>
              OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status),
          );
        const done = mine.filter((t) => t.status === "done");
        const row = (t: V3Ticket) => (
          <RowButton
            key={t.id}
            opens={{ page: "ticket", id: t.id }}
            onClick={() => go({ page: "ticket", id: t.id })}
            className={cn(
              PCOLS,
              "min-h-[41px] rounded-none border-[var(--v3-line)] border-b py-2.5 text-[14px]",
            )}
          >
            <span className="truncate">
              <TicketId id={t.id} />
              {t.title}
              {t.status === "stuck" && (
                <span className={cn(INK.stuck, "opacity-80")}>
                  {" "}
                  · {t.stuckWhy}
                </span>
              )}
              {t.status === "planned" && t.startsAt && (
                <span className="text-muted-foreground/70">
                  {" "}
                  · starts {t.startsAt}
                </span>
              )}
            </span>
            <span className={WIDE}>
              <Who data={data} id={t.owner} />
            </span>
            <StatusPill status={t.status} className="justify-self-start" />
            <Since t={t} />
          </RowButton>
        );
        return (
          <section key={p.id} className="mt-8">
            <RowButton
              onClick={() => go({ page: "project", id: p.id })}
              className="mb-1 flex items-center gap-2.5 py-1"
            >
              <ProjectMark name={p.name} tone={p.tone} />
              <span className="font-semibold text-[15px]">{p.name}</span>
              <span className="font-mono text-[12.5px] text-muted-foreground/70">
                {p.folder}
              </span>
              <small className="ml-auto text-[13px] text-muted-foreground/70">
                {open.length} open
              </small>
            </RowButton>
            {open.map(row)}
            {done.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setShowDone((s) => ({ ...s, [p.id]: !s[p.id] }))
                  }
                  className="flex items-center gap-2 py-2.5 text-[13px] text-muted-foreground hover:text-foreground"
                >
                  <Triangle open={!!showDone[p.id]} />
                  {done.length} done
                </button>
                {showDone[p.id] && done.map(row)}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
