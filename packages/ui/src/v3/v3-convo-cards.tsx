import { Fragment } from "react";
import { ago, Btn, StatusPill } from "./v3-bits";
import { agentOf } from "./v3-model";
import type {
  V3Agent,
  V3Ask,
  V3Data,
  V3PageProps,
  V3Thread,
  V3Ticket,
  V3Turn,
} from "./v3-types";

/* The quiet lines and cards around a conversation: how the thread opened,
   what it waits on, where it is stuck, and the "working" indicator. */

/** "CEO handed LIL-81 to Builder · 11:02": the event that started a ticket
   thread, set between hairlines so it never reads as a message. */
export function Opening({
  data,
  thread,
  first,
}: {
  data: V3Data;
  thread: V3Thread;
  /** The oldest turn on record. */
  first?: V3Turn;
}) {
  const ticketId = thread.ticketId;
  if (!ticketId) return null;
  const agent = agentOf(data, thread.agentId);
  const ceo = data.agents.find((a) => !a.reportsTo) ?? data.agents[0];
  // Only turn 1 knows who asked and when; if the early turns are not on
  // record, the hand-off time is the thread's start and the asker the CEO.
  const known = first?.n === 1 ? first : undefined;
  const from = known?.from ?? "";
  const asker = known?.prompt?.by;
  const who =
    asker === "you" || from.startsWith("handed over")
      ? "You"
      : asker
        ? agentOf(data, asker).name
        : (/^asked by (.+?) at /.exec(from)?.[1] ?? ceo.name);
  const at =
    known?.prompt?.at ?? /\d{1,2}:\d{2}/.exec(from)?.[0] ?? thread.startedAt;
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground/70">
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
      <span className="max-w-[80%] text-center">
        {who === agent.name
          ? `${who} started ${ticketId}`
          : `${who} handed ${ticketId} to ${agent.name}`}{" "}
        · {at}
      </span>
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
    </div>
  );
}

/** The thread waits on you: the ask, why, both outcomes, and the answer. */
export function AskCard({
  ask,
  from,
  act,
}: {
  ask: V3Ask;
  from: V3Agent;
  act: V3PageProps["act"];
}) {
  const question = ask.kind === "question";
  const rows: [string, string][] = [
    ["Why", ask.why],
    [question ? "If yes" : "If you approve", ask.ifYes],
    [question ? "If no" : "If you deny", ask.ifNo],
  ];
  return (
    <div className="rounded-[10px] border border-[var(--v3-line)] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
        <StatusPill status="needs" />
        <span>
          {from.name} asks · waiting {ago(ask.waiting)}
        </span>
      </div>
      <p className="mt-2.5 text-[14.5px] text-foreground leading-normal">
        {ask.ask}
      </p>
      <div className="mt-3 grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px] leading-normal">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span className="text-muted-foreground">{k}</span>
            <span className="text-foreground">{v}</span>
          </Fragment>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[12.5px] text-muted-foreground/70">
          If you don’t answer by {ask.fallback.at}, the CEO {ask.fallback.does}.
        </span>
        {question ? (
          (ask.options ?? []).map((o) => (
            <Btn key={o} onClick={() => act.answer(ask.id, o)}>
              {o}
            </Btn>
          ))
        ) : (
          <>
            <Btn onClick={() => act.deny(ask.id)}>Deny</Btn>
            <Btn primary onClick={() => act.approve(ask.id)}>
              Approve{ask.spend ? ` $${ask.spend.amount}` : ""}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

/** The agent is looping: what it keeps doing, and how to step in. */
export function StuckCard({
  thread,
  ticket,
  handTo,
  act,
}: {
  thread: V3Thread;
  ticket?: V3Ticket;
  handTo: V3Agent;
  act: V3PageProps["act"];
}) {
  const stuck = thread.stuck;
  if (!stuck) return null;
  const ticketId = thread.ticketId;
  const fallback = ticket?.fallback;
  return (
    <div className="rounded-[10px] border border-red-200 bg-red-50/60 px-4 py-3.5 dark:border-red-400/25 dark:bg-red-400/8">
      <div className="flex items-center gap-2 text-[13.5px]">
        <StatusPill status="stuck" />
        <b className="font-semibold text-red-700 dark:text-red-300">
          {stuck.what}
        </b>
        {thread.now && (
          <span className="text-red-600/80 dark:text-red-300/80">
            · {thread.now.elapsed}
          </span>
        )}
      </div>
      <div className="mt-2.5 rounded-[7px] bg-background/70 px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]">
        {stuck.detail.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      {fallback && (
        <p className="mt-2.5 text-[12.5px] text-red-600/80 dark:text-red-300/80">
          Unless you step in, the CEO {fallback.does} at {fallback.at}.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Btn small onClick={() => act.stop(thread.id)}>
          Stop
        </Btn>
        {ticketId && (
          <Btn small onClick={() => act.handOff(ticketId, handTo.id)}>
            Hand to {handTo.name}
          </Btn>
        )}
      </div>
    </div>
  );
}

/** Between steps, or before the first one: the agent is on it. */
export function Typing({ agent, text }: { agent: V3Agent; text?: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground"
    >
      <span aria-hidden className="inline-flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ animationDelay: `${i * 0.25}s` }}
            className="size-[5px] rounded-full bg-muted-foreground/70 motion-safe:animate-pulse"
          />
        ))}
      </span>
      <span>
        {agent.name} is working{text ? ` · ${text}` : ""}
      </span>
    </div>
  );
}
