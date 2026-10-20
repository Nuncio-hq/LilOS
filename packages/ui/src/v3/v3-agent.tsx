import {
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import {
  AgentAvatar,
  Avatar,
  ago,
  Btn,
  CeoMark,
  Meter,
  Page,
  Prop,
  Section,
  StatusPill,
  Title,
} from "./v3-bits";
import { agentOf, agentStatus, agentTicket } from "./v3-model";
import { ThreadRow, TicketRow } from "./v3-rows";
import { soonestNext } from "./v3-schedule-text";
import { AgentSchedules } from "./v3-schedules";
import type { V3ConnectorDef, V3PageProps } from "./v3-types";

/* One agent, like a person's profile in Notion: what it does, what it runs
   on, what it has been plugged into, and how far to trust it this week. An
   outside worker gets the same page minus everything LilOS runs (runtime,
   model, skills, spend, instructions, memory): LilOS only watches it. */

const PILL =
  "inline-flex h-[24px] items-center gap-1.5 rounded-md border border-[var(--v3-line)] px-2 text-[13px] text-foreground";

const STATE_WORD: Record<V3ConnectorDef["state"], string> = {
  ready: "Ready",
  "signed-out": "Not signed in",
  missing: "Not found",
};

/** A connector's state on a chip: a green dot, or a quiet word when it needs
   you. Colour is for state; the mark carries the connector's own colour. */
function ChipState({ state }: { state: V3ConnectorDef["state"] }) {
  if (state === "ready")
    return (
      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
    );
  return state === "signed-out" ? (
    <span className="text-[12px] text-amber-700 dark:text-amber-300">
      sign in
    </span>
  ) : (
    <span className="text-[12px] text-muted-foreground/70">not found</span>
  );
}

/** The connectors this agent's sessions get. A chip turns its connector off;
   `+ Add` lists the rest and links to where connectors are managed. */
function Connectors({
  connectors,
  agentId,
  agentName,
  go,
  act,
}: {
  connectors: V3ConnectorDef[];
  agentId: string;
  agentName: string;
} & Pick<V3PageProps, "go" | "act">) {
  const [open, setOpen] = useState(false);
  const on = connectors.filter((c) => c.agents.includes(agentId));
  const off = connectors.filter((c) => !c.agents.includes(agentId));
  return (
    <>
      {on.map((c) => (
        <button
          key={c.id}
          type="button"
          title={`Turn ${c.label} off for ${agentName}`}
          onClick={() => act.toggleConnector(c.id, agentId)}
          className={cn(PILL, "transition-colors hover:bg-[var(--v3-hover)]")}
        >
          <Avatar name={c.label} tone="n" size={16} look={c.look} />
          {c.label}
          <ChipState state={c.state} />
        </button>
      ))}
      {on.length === 0 && (
        <span className="text-[13px] text-muted-foreground">None</span>
      )}
      <span className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-[13px] text-muted-foreground/70 hover:text-foreground"
        >
          + Add
        </button>
        {open && (
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div className="absolute top-full left-0 z-20 mt-1 w-[230px] rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]">
              {off.length === 0 && (
                <p className="px-3 py-1.5 text-muted-foreground">
                  Every connector is on.
                </p>
              )}
              {off.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    act.toggleConnector(c.id, agentId);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-[var(--v3-hover)]"
                >
                  <Avatar name={c.label} tone="n" size={16} look={c.look} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.state !== "ready" && <ChipState state={c.state} />}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  go({ page: "settings" });
                }}
                className="mt-1 flex w-full items-center border-[var(--v3-line)] border-t px-3 pt-2 pb-1.5 text-left text-muted-foreground hover:text-foreground"
              >
                Manage connectors…
              </button>
            </div>
          </>
        )}
      </span>
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
  const outside = agent.kind === "outside";
  const via = outside
    ? data.connectors.find((c) => c.id === agent.via)
    : undefined;
  const status = agentStatus(data, agent.id);
  const current = status === "idle" ? undefined : agentTicket(data, agent.id);
  const tickets = data.tickets.filter((t) => t.owner === agent.id);
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  const ceo = agentOf(data, data.ceoId);
  const holdsCeo = agent.id === data.ceoId;
  // CEO is a position: everyone reports to its holder, the holder to you.
  const boss = holdsCeo ? "You" : ceo.name;
  const spendPct = (agent.spend.used / agent.spend.cap) * 100;
  const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));
  // The soonest scheduled job that is not paused: Works says when it is due.
  const nextJob = outside
    ? undefined
    : soonestNext(data.schedules.filter((s) => s.agentId === agent.id));

  return (
    <Page wide>
      <div className="flex items-center gap-4">
        <AgentAvatar data={data} agent={agent} size={56} />
        <div className="min-w-0 flex-1">
          <Title
            kicker={
              outside
                ? `Outside worker · via ${via?.label ?? "a connector"} · reports to ${boss}`
                : `${agent.role} · reports to ${boss} · hired ${agent.hired}`
            }
          >
            {agent.name}
            {holdsCeo && <CeoMark className="ml-2.5 align-middle" />}
          </Title>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!outside && (
            <Btn onClick={() => go({ page: "newchat", id: agent.id })}>
              Message
            </Btn>
          )}
          <Btn primary onClick={() => act.ask(`@${agent.name} `)}>
            Give a ticket
          </Btn>
          {!outside && !holdsCeo && (
            <button
              type="button"
              title={`Move the CEO position to ${agent.name}`}
              onClick={() => act.makeCeo(agent.id)}
              className="h-7 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
            >
              Make CEO
            </button>
          )}
        </div>
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
        {outside ? (
          <Prop icon={<PlugIcon />} label="Reached through">
            {via ? (
              <>
                <Avatar name={via.label} tone="n" size={16} look={via.look} />
                <span className="text-foreground">{via.label}</span>
                <span className="text-muted-foreground">
                  · {via.kind === "mcp" ? "MCP" : "CLI"} ·{" "}
                  {STATE_WORD[via.state]}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Connector removed</span>
            )}
          </Prop>
        ) : (
          <>
            <Prop icon={<CpuIcon />} label="Runs on">
              {agent.runtime}
            </Prop>
            <Prop icon={<SparklesIcon />} label="Model">
              {agent.model}
            </Prop>
          </>
        )}
        <Prop icon={<ClockIcon />} label="Works">
          {agent.schedule}
          {nextJob && (
            <span className="text-muted-foreground">· Next: {nextJob}</span>
          )}
        </Prop>
        {!outside && (
          <>
            <Prop icon={<PlugIcon />} label="Connectors">
              <Connectors
                connectors={data.connectors}
                agentId={agent.id}
                agentName={agent.name}
                go={go}
                act={act}
              />
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
          </>
        )}
      </div>

      {outside && (
        <p className="mt-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-3 py-2.5 text-[13.5px] text-muted-foreground leading-relaxed">
          An outside bot, not a LilOS agent. Its steps come through the{" "}
          {via?.label ?? "connector"} connector; LilOS shows them but does not
          run it.
        </p>
      )}

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

      {!outside && (
        <AgentSchedules data={data} go={go} act={act} agentId={agent.id} />
      )}

      {!outside && (
        <>
          <Section title="Instructions" />
          <div className="space-y-2.5 border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] leading-relaxed text-foreground">
            {agent.instructions.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {agent.suggestion && (
            <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[13.5px] dark:border-sky-400/25 dark:bg-sky-400/10">
              <AgentAvatar data={data} agent={ceo} className="mt-px" />
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
        </>
      )}

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
