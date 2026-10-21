import { cn } from "../lib/utils";
import { Section } from "./v3-bits";
import { INK } from "./v3-marks";
import type { V3PageProps } from "./v3-page-types";
import { TicketRow } from "./v3-rows";
import type { V3Agent, V3Ticket } from "./v3-types";

/* This week on an agent's page. Real threads use `weekThreads`: finished
   and failed from the same status Threads uses, stuck from stuckAt this
   week (a recovered thread still counts). The prototype's ticket week
   stays when that count is absent. A section with neither is not drawn
   (D-#19). Colour is only a count above zero. */

function Stat({
  value,
  label,
  ink,
}: {
  value: string | number;
  label: string;
  ink?: string;
}) {
  return (
    <div className="border-[var(--v3-line)] border-r px-4 py-3 first:pl-0 last:border-r-0">
      <b
        className={cn(
          "lilos-v3-serif block font-bold text-[28px] leading-tight",
          ink ?? "text-foreground",
        )}
      >
        {value}
      </b>
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function AgentWeek({
  data,
  go,
  agent,
  tickets,
}: Pick<V3PageProps, "data" | "go"> & {
  agent: V3Agent;
  tickets: V3Ticket[];
}) {
  const w = agent.weekThreads;
  if (w) {
    return (
      <>
        <Section title="This week" />
        <div className="mt-2 grid grid-cols-3 border-[var(--v3-line)] border-y">
          <Stat value={w.finished} label="threads finished" />
          <Stat
            value={w.failed}
            label="threads failed"
            ink={w.failed > 0 ? INK.failed : undefined}
          />
          <Stat
            value={w.stuck}
            label="threads stuck"
            ink={w.stuck > 0 ? INK.stuck : undefined}
          />
        </div>
      </>
    );
  }
  if (!agent.week && tickets.length === 0) return null;
  return (
    <>
      <Section title={agent.week ? "This week" : "Tickets"} />
      {agent.week && (
        <div className="mt-2 grid grid-cols-4 border-[var(--v3-line)] border-y">
          <Stat value={agent.week.done} label="tickets done" />
          <Stat value={agent.week.typical} label="typical ticket" />
          <Stat value={agent.week.stuck} label="times stuck" />
          <Stat value={agent.week.handed} label="handed to someone else" />
        </div>
      )}
      <div
        className={cn(
          agent.week && "mt-2.5",
          "border-[var(--v3-line)] border-t",
        )}
      >
        {tickets.length === 0 && (
          <p className="py-3 text-[14px] text-muted-foreground">
            No tickets this week.
          </p>
        )}
        {tickets.map((t) => (
          <TicketRow key={t.id} data={data} ticket={t} go={go} />
        ))}
      </div>
    </>
  );
}
