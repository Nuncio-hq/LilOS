import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Page, Section, span, Title } from "./v3-bits";
import { Statuses } from "./v3-guide-bits";
import { V3GuideToday } from "./v3-guide-today";
import { ThreadPill } from "./v3-live";
import { AgentAvatar, StatusPill } from "./v3-marks";
import {
  agentNameOf,
  agentOf,
  FORMER_AGENT,
  goalOf,
  goalProgress,
  threadsOf,
  ticketOf,
} from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";

/* The explainer: five levels, a hand-off chain, how a thread lives. All
   examples come from live data so the page matches what you see elsewhere. */

const EXAMPLE_TICKET = "HB-12";
const EXAMPLE_THREAD = "t-lil81";

function Lbl({ children }: { children: string }) {
  return (
    <span className="px-0.5 text-[12.5px] text-muted-foreground/70">
      {children}
    </span>
  );
}

function Flow({ children }: { children: ReactNode }) {
  return (
    <div className="my-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {children}
    </div>
  );
}

export function V3Guide(props: V3PageProps) {
  return props.data.features.tickets ? (
    <V3GuideTickets {...props} />
  ) : (
    <V3GuideToday data={props.data} go={props.go} />
  );
}

function V3GuideTickets({ data, go }: V3PageProps) {
  const ticket = ticketOf(data, EXAMPLE_TICKET);
  const hops = threadsOf(data, EXAMPLE_TICKET);
  const goal = ticket?.goalId ? goalOf(data, ticket.goalId) : undefined;
  const goalCount = goal ? goalProgress(data, goal.id).total : 0;
  const thread = data.threads.find((t) => t.id === EXAMPLE_THREAD);
  // Turns the app does not carry (empty) leave their counts out, never 0.
  const turn = thread?.turns[0];
  const run =
    turn?.steps?.find((s) => s.running) ??
    turn?.steps?.find((s) => s.kind === "run");
  const stepsIn = (thread?.step ?? 0) || (turn?.steps?.length ?? 0);
  const hasCeo = data.agents.some((a) => a.id === data.ceoId);

  const levels = [
    {
      name: "Goal",
      eg: goal?.title ?? "A goal",
      n: `${goalCount} tickets`,
      df: hasCeo
        ? "What the company wants. The CEO splits it into tickets."
        : "What the company wants, split into tickets.",
      go: goal ? () => go({ page: "goal", id: goal.id }) : undefined,
    },
    {
      name: "Ticket",
      eg: ticket ? `${ticket.id} ${ticket.title}` : EXAMPLE_TICKET,
      n: `${hops.length} threads`,
      df: "One piece of work: one owner, one status at a time.",
      go: ticket ? () => go({ page: "ticket", id: ticket.id }) : undefined,
    },
    {
      name: "Thread",
      eg: thread
        ? `${agentNameOf(data, thread.agentId)} · ${thread.ticketId ? `${thread.ticketId} ` : ""}${thread.title.toLowerCase()}`
        : "A thread",
      n:
        thread && thread.turns.length > 0
          ? `${Math.max(...thread.turns.map((t) => t.n))} turns`
          : "",
      df: "One agent working in one folder with one model. A new thread each time the ticket changes hands.",
      go: thread ? () => go({ page: "thread", id: thread.id }) : undefined,
    },
    {
      name: "Turn",
      eg: turn ? `Turn ${turn.n} · ${turn.from}` : "A turn",
      n: turn && stepsIn > 0 ? `${stepsIn} steps` : "",
      df: "One run, from a message to an answer.",
    },
    {
      name: "Step",
      eg: run ? `Ran ${run.target}` : "A step",
      n: run?.meta ?? "",
      df: "One action: read, edit, run, search, browse, delegate.",
    },
  ];

  return (
    <Page wide>
      <Title>How the company works</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Every number on every screen counts one of five things.
      </p>

      <Section title="From goal to step" />
      <div className="border-[var(--v3-line)] border-t">
        {levels.map((l, i) => {
          const row = (
            <div className="grid grid-cols-[150px_330px_minmax(0,1fr)] items-baseline gap-5 py-[11px] text-[13.5px] @max-[760px]:grid-cols-1 @max-[760px]:gap-1">
              <div className="font-semibold text-[14px]">
                {i > 0 && (
                  <i className="mr-1.5 font-normal text-muted-foreground/70 not-italic">
                    ↳
                  </i>
                )}
                {l.name}
              </div>
              <div>
                {l.eg}{" "}
                <span className="text-muted-foreground/70">
                  {l.n && `· ${l.n}`}
                </span>
              </div>
              <div className="text-muted-foreground">{l.df}</div>
            </div>
          );
          return (
            <div key={l.name} className="border-[var(--v3-line)] border-b">
              {l.go ? (
                <RowButton onClick={l.go}>{row}</RowButton>
              ) : (
                <div className="-mx-2 px-2">{row}</div>
              )}
            </div>
          );
        })}
      </div>

      <Section title={`${EXAMPLE_TICKET} changed hands ${hops.length} times`} />
      <div className="mt-2 flex items-stretch @max-[760px]:flex-col">
        {hops.map((t, i) => {
          const a = agentOf(data, t.agentId);
          const turns =
            t.turns.length > 0 ? Math.max(...t.turns.map((x) => x.n)) : 0;
          return (
            <div key={t.id} className="flex min-w-0 flex-1 items-stretch">
              {i > 0 && (
                <span className="grid w-7 shrink-0 place-items-center text-muted-foreground/70">
                  <ArrowRightIcon className="size-4" />
                </span>
              )}
              <button
                type="button"
                onClick={() => go({ page: "thread", id: t.id })}
                className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-[10px] border border-[var(--v3-line)] px-3.5 py-3 text-left text-[13px] hover:bg-[var(--v3-hover)]"
              >
                <span className="flex items-center gap-2 text-[13.5px]">
                  <AgentAvatar data={data} agent={a} />
                  {a?.name ?? FORMER_AGENT}
                </span>
                <span>{t.title}</span>
                <span className="text-muted-foreground">
                  {span(t.minutes)}
                  {turns > 0 && ` · ${turns} ${turns === 1 ? "turn" : "turns"}`}
                </span>
                <ThreadPill status={t.status} />
              </button>
            </div>
          );
        })}
      </div>

      <Section title="The life of a thread" />
      <Flow>
        <StatusPill status="working" />
        <Lbl>asks →</Lbl>
        <StatusPill status="needs" />
        <Lbl>you answer →</Lbl>
        <StatusPill status="working" />
        <Lbl>answers →</Lbl>
        <ThreadPill status="done" />
        <Lbl>30 min quiet →</Lbl>
        <StatusPill status="idle" />
        <Lbl>next message → back to Working, same memory</Lbl>
      </Flow>
      <Flow>
        <StatusPill status="working" />
        <Lbl>error →</Lbl>
        <StatusPill status="failed" />
        <Lbl>Retry →</Lbl>
        <StatusPill status="working" />
        <Lbl>·</Lbl>
        <StatusPill status="working" />
        <Lbl>■ Stop or ⌘. →</Lbl>
        <StatusPill status="idle" label="Stopped" />
        <Lbl>·</Lbl>
        <StatusPill status="working" />
        <Lbl>same step for too long →</Lbl>
        <StatusPill status="stuck" />
      </Flow>

      <Statuses tickets />
    </Page>
  );
}
