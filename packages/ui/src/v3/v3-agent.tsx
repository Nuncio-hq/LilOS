import {
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  GlobeIcon,
  MailIcon,
  PlugIcon,
  SheetIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import {
  Avatar,
  ago,
  Btn,
  Meter,
  Page,
  Prop,
  Section,
  StatusPill,
  Title,
} from "./v3-bits";
import { agentOf, agentStatus, agentTicket } from "./v3-model";
import { ThreadRow, TicketRow } from "./v3-rows";
import type { V3Agent, V3Connector, V3PageProps } from "./v3-types";

/* One agent, like a person's profile in Notion: what it does, what it runs
   on, what it has been plugged into, and how far to trust it this week. */

const CONNECTOR_ICON: Record<V3Connector["icon"], typeof GlobeIcon> = {
  web: GlobeIcon,
  bolt: ZapIcon,
  spark: SparklesIcon,
  mail: MailIcon,
  sheet: SheetIcon,
};

const PILL =
  "inline-flex h-[24px] items-center gap-1.5 rounded-md border border-[var(--v3-line)] px-2 text-[13px] text-foreground";

function Connectors({ agent }: { agent: V3Agent }) {
  // Switching a connector on is local to the prototype; the data stays as it was.
  const [enabled, setEnabled] = useState<string[]>([]);
  const isOn = (c: V3Connector) => c.on || enabled.includes(c.name);
  const firstOff = agent.connectors.find((c) => !isOn(c));
  return (
    <>
      {agent.connectors.map((c) => {
        const Icon = CONNECTOR_ICON[c.icon];
        const on = isOn(c);
        return (
          <span
            key={c.name}
            className={cn(PILL, !on && "text-muted-foreground")}
          >
            <Icon className="size-3.5 opacity-70" />
            {c.name}
            {on && (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-emerald-500"
              />
            )}
          </span>
        );
      })}
      {firstOff && (
        <button
          type="button"
          onClick={() => setEnabled((e) => [...e, firstOff.name])}
          className="text-[13px] text-muted-foreground/70 hover:text-foreground"
        >
          + Add
        </button>
      )}
    </>
  );
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="border-[var(--v3-line)] border-r px-4 py-3 first:pl-0 last:border-r-0">
      <b className="lilos-v3-serif block font-bold text-[28px] leading-tight text-foreground">
        {value}
      </b>
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function V3AgentPage({
  data,
  go,
  act,
  id,
}: V3PageProps & { id: string }) {
  const found = data.agents.find((a) => a.id === id);
  if (!found) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">Agent not found.</p>
      </Page>
    );
  }
  const agent = found;
  const status = agentStatus(data, agent.id);
  const current = status === "idle" ? undefined : agentTicket(data, agent.id);
  const tickets = data.tickets.filter((t) => t.owner === agent.id);
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  const boss = agent.reportsTo ? agentOf(data, agent.reportsTo).name : "You";
  const ceo = data.agents.find((a) => !a.reportsTo) ?? data.agents[0];
  const spendPct = (agent.spend.used / agent.spend.cap) * 100;
  const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));

  return (
    <Page wide>
      <div className="flex items-center gap-4">
        <Avatar name={agent.name} tone={agent.tone} size={56} />
        <div className="min-w-0 flex-1">
          <Title
            kicker={`${agent.role} · reports to ${boss} · hired ${agent.hired}`}
          >
            {agent.name}
          </Title>
        </div>
        <Btn primary onClick={() => act.ask(`@${agent.name} `)}>
          Give a ticket
        </Btn>
      </div>

      <div className="mt-3">
        <Prop icon={<ClockIcon />} label="Now">
          <StatusPill status={status} />
          {current ? (
            <span className="text-foreground">
              {current.title} ·{" "}
              <button
                type="button"
                onClick={() => go({ page: "ticket", id: current.id })}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {current.id}
              </button>{" "}
              <span className="text-muted-foreground">
                · {ago(current.since)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {agent.next ?? "Nothing assigned"}
            </span>
          )}
        </Prop>
        <Prop icon={<CpuIcon />} label="Runs on">
          {agent.runtime}
        </Prop>
        <Prop icon={<SparklesIcon />} label="Model">
          {agent.model}
        </Prop>
        <Prop icon={<ClockIcon />} label="Works">
          {agent.schedule}
        </Prop>
        <Prop icon={<PlugIcon />} label="Connectors">
          <Connectors key={agent.id} agent={agent} />
        </Prop>
        <Prop icon={<BookOpenIcon />} label="Skills">
          {agent.skills.map((s) => (
            <span key={s} className={PILL}>
              {s}
            </span>
          ))}
        </Prop>
        <Prop icon={<CoinsIcon />} label="Spend">
          <Meter value={spendPct} className="w-[90px]" />
          <span className="text-[14px] text-foreground">
            ${fmt(agent.spend.used)} of ${agent.spend.cap} this{" "}
            {agent.spend.period}
          </span>
        </Prop>
      </div>

      <Section title="This week" />
      <div className="mt-2 grid grid-cols-4 border-[var(--v3-line)] border-y">
        <Stat value={agent.week.done} label="tickets done" />
        <Stat value={agent.week.typical} label="typical ticket" />
        <Stat value={agent.week.stuck} label="times stuck" />
        <Stat value={agent.week.handed} label="handed to someone else" />
      </div>
      <div className="mt-2.5 border-[var(--v3-line)] border-t">
        {tickets.length === 0 && (
          <p className="py-3 text-[14px] text-muted-foreground">
            No tickets this week.
          </p>
        )}
        {tickets.map((t) => (
          <TicketRow key={t.id} data={data} ticket={t} go={go} />
        ))}
      </div>

      <Section title="Instructions" />
      <div className="space-y-2.5 border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] leading-relaxed text-foreground">
        {agent.instructions.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      {agent.suggestion && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[13.5px] dark:border-sky-400/25 dark:bg-sky-400/10">
          <Avatar name={ceo.name} tone={ceo.tone} className="mt-px" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-foreground">
              CEO suggests a rule
            </span>{" "}
            <span className="text-muted-foreground">
              · after {agent.suggestion.after} got stuck
            </span>
            <div className="mt-1">
              <span className="rounded-[3px] bg-emerald-100 px-1 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200">
                {agent.suggestion.text}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Btn small onClick={() => act.dismissRule(agent.id)}>
              Dismiss
            </Btn>
            <Btn small primary onClick={() => act.acceptRule(agent.id)}>
              Accept
            </Btn>
          </div>
        </div>
      )}

      <Section title="Remembers" count={agent.memory.length} />
      <ul className="border-[var(--v3-line)] border-t text-[14px]">
        {agent.memory.map((m) => (
          <li
            key={m.text}
            className="flex items-baseline gap-4 border-[var(--v3-line)] border-b py-2 text-foreground"
          >
            <span className="min-w-0 flex-1">{m.text}</span>
            <span className="shrink-0 text-[12.5px] text-muted-foreground/70">
              {m.source}
            </span>
          </li>
        ))}
      </ul>

      <Section title="Threads" count={threads.length} />
      <div className="border-[var(--v3-line)] border-t">
        {threads.length === 0 && (
          <p className="py-3 text-[14px] text-muted-foreground">
            No threads yet.
          </p>
        )}
        {threads.map((t) => (
          <ThreadRow key={t.id} data={data} thread={t} go={go} />
        ))}
      </div>
    </Page>
  );
}
