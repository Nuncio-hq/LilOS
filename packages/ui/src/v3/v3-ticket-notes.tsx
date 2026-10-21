import { ClockIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { ago, Btn, Prop } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, INK } from "./v3-marks";
import {
  agentOf,
  defaultAgent,
  FORMER_AGENT,
  threadsOf,
  ticketOf,
} from "./v3-model";
import type { V3PageProps, V3Route } from "./v3-page-types";
import type { V3Ticket } from "./v3-types";

/* The ticket page's "who is it waiting on" row and the stuck / asking
   callouts. They live apart from v3-ticket.tsx so the page file keeps only the
   page and its sections; `link` and `Person` are exported because the page
   shares them with the row below. */

export const link = "border-foreground/25 border-b hover:border-foreground/60";

export function Person({ data, id }: { data: V3Data; id: string }) {
  if (!id) return <span className="text-muted-foreground">Unassigned</span>;
  if (id === "you") return <span className="font-medium">{data.me}</span>;
  const a = agentOf(data, id);
  return (
    <span className="flex items-center gap-2 font-medium">
      <AgentAvatar data={data} agent={a} />
      {a?.name ?? FORMER_AGENT}
    </span>
  );
}

/** Stuck: say why, and what happens if nobody moves it. Handing it on and
    marking it done live once, with the other ticket controls. */
export function StuckNote({
  data,
  t,
  act,
}: { data: V3Data; t: V3Ticket } & Pick<V3PageProps, "act">) {
  const threadId = threadsOf(data, t.id).find((x) => x.status === "stuck")?.id;
  return (
    <div className="mt-3 rounded-lg bg-red-50/70 px-3.5 py-3 text-[14px] dark:bg-red-400/10">
      <div className={cn("font-medium", INK.stuck)}>
        Not moving: {t.stuckWhy}
      </div>
      {t.fallback && (
        <div className="mt-0.5 text-[13.5px] text-muted-foreground">
          At {t.fallback.at} the CEO {t.fallback.does}.
        </div>
      )}
      {threadId && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Btn small onClick={() => act.stop(threadId)}>
            Stop
          </Btn>
        </div>
      )}
    </div>
  );
}

/** The owner's two moves, once on the page: hand any open ticket to any
    agent, and mark it done. Neither is drawn without a handler (D-#19). */
export function TicketMoves({
  data,
  t,
  act,
}: { data: V3Data; t: V3Ticket } & Pick<V3PageProps, "act">) {
  const [picking, setPicking] = useState(false);
  if (t.status === "done") return null;
  const handOff = act.handOff;
  const markDone = act.markDone;
  if (!handOff && !markDone) return null;
  return (
    <>
      {handOff && (
        <Btn small onClick={() => setPicking((p) => !p)}>
          Hand to …
        </Btn>
      )}
      {handOff &&
        picking &&
        data.agents.map((a) => (
          <Btn
            small
            key={a.id}
            onClick={() => {
              handOff(t.id, a.id);
              setPicking(false);
            }}
          >
            <AgentAvatar data={data} agent={a} size={16} />
            {a.name}
          </Btn>
        ))}
      {markDone && (
        <Btn small onClick={() => markDone(t.id)}>
          Mark done
        </Btn>
      )}
    </>
  );
}

/** Waiting on you: the question and its answers, right on the page. */
export function AskNote({
  data,
  t,
  act,
}: { data: V3Data; t: V3Ticket } & Pick<V3PageProps, "act">) {
  const w = t.waitingOn;
  const ask =
    w?.kind === "you" ? data.asks.find((a) => a.id === w.askId) : undefined;
  if (!ask) return null;
  const answers = ask.kind === "question" ? (ask.options ?? []) : undefined;
  return (
    <div className="mt-3 rounded-lg bg-orange-50/70 px-3.5 py-3 text-[14px] dark:bg-orange-400/10">
      <div className="font-medium">{ask.ask}</div>
      {ask.why && (
        <div className="mt-0.5 text-[13.5px] text-muted-foreground">
          {ask.why}
        </div>
      )}
      {(ask.fallback || !answers || answers.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {answers ? (
            answers.map((o, i) => (
              <Btn
                small
                primary={i === 0}
                key={o}
                onClick={() => act.answer(ask.id, o)}
              >
                {o}
              </Btn>
            ))
          ) : (
            <>
              <Btn small primary onClick={() => act.approve(ask.id)}>
                Approve
              </Btn>
              <Btn small onClick={() => act.deny(ask.id)}>
                Deny
              </Btn>
            </>
          )}
          {ask.fallback && (
            <span className="text-[13px] text-muted-foreground/70">
              Otherwise at {ask.fallback.at} the CEO {ask.fallback.does}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Whoever holds the seat now, else the default agent. Never a stored id. */
function CeoWait({ data }: { data: V3Data }) {
  const ceo =
    data.agents.find((a) => a.id === data.ceoId) ?? defaultAgent(data);
  if (!ceo) return <span className="font-medium">the CEO</span>;
  return <Person data={data} id={ceo.id} />;
}

export function WaitingOn({
  data,
  t,
  go,
}: {
  data: V3Data;
  t: V3Ticket;
  go: (r: V3Route) => void;
}) {
  const w = t.waitingOn;
  if (!w) return null;
  return (
    <Prop icon={<ClockIcon />} label="Waiting on">
      {w.kind === "you" && (
        <>
          <button
            type="button"
            className={cn("font-medium", link)}
            onClick={() => go({ page: "needs" })}
          >
            You
          </button>
          <span className="text-muted-foreground">
            for your answer · {ago(t.since)}
          </span>
        </>
      )}
      {w.kind === "agent" && (
        <>
          <Person data={data} id={w.agentId} />
          <span className="text-muted-foreground">
            {w.why} · {ago(t.since)}
          </span>
        </>
      )}
      {w.kind === "ticket" && (
        <>
          <button
            type="button"
            className={link}
            onClick={() => go({ page: "ticket", id: w.ticketId })}
          >
            {w.ticketId} {ticketOf(data, w.ticketId)?.title}
          </button>
          <span className="text-muted-foreground">· {ago(t.since)}</span>
        </>
      )}
      {w.kind === "ceo" && (
        <>
          <CeoWait data={data} />
          <span className="text-muted-foreground">· {ago(t.since)}</span>
        </>
      )}
    </Prop>
  );
}
