import {
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Connectors, PILL } from "./v3-agent-connectors";
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
   model, skills, spend, instructions, memory): LilOS only watches it.
   What the app cannot tell (runtime, schedule, skills, spend, memory, week)
   or cannot change (connectors, rules, the CEO position) is left out, never
   shown as a made-up value or a dead control. */

const STATE_WORD: Record<V3ConnectorDef["state"], string> = {
  ready: "Ready",
  "signed-out": "Not signed in",
  missing: "Not found",
};

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
  const agent = agentOf(data, id);
  // The id outlived the agent (fired, or an old link): there is no record to
  // show, and no other agent's page to show in its place.
  if (!agent) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">
          This agent is no longer on the team.
        </p>
      </Page>
    );
  }
  const outside = agent.kind === "outside";
  const via = outside
    ? data.connectors.find((c) => c.id === agent.via)
    : undefined;
  const status = agentStatus(data, agent.id);
  const current = status === "idle" ? undefined : agentTicket(data, agent.id);
  const tickets = data.tickets.filter((t) => t.owner === agent.id);
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  // CEO is a position, and the app may have none: then the page says nothing
  // about who this agent reports to and offers no way to move the position.
  const ceo = data.agents.find((a) => a.id === data.ceoId);
  const holdsCeo = !!ceo && agent.id === ceo.id;
  // Everyone reports to its holder, the holder to you.
  const boss = ceo && (holdsCeo ? "You" : ceo.name);
  const reportsTo = boss ? ` · reports to ${boss}` : "";
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
                ? `Outside worker · via ${via?.label ?? "a connector"}${reportsTo}`
                : `${agent.role}${reportsTo} · hired ${agent.hired}`
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
          {/* A ticket is drafted through the CEO in ⌘K: tickets only. */}
          {data.features.tickets && (
            <Btn primary onClick={() => act.ask(`@${agent.name} `)}>
              Give a ticket
            </Btn>
          )}
          {!outside && ceo && !holdsCeo && act.makeCeo && (
            <button
              type="button"
              title={`Move the CEO position to ${agent.name}`}
              onClick={() => act.makeCeo?.(agent.id)}
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
            {agent.runtime && (
              <Prop icon={<CpuIcon />} label="Runs on">
                {agent.runtime}
              </Prop>
            )}
            <Prop icon={<SparklesIcon />} label="Model">
              {agent.model}
            </Prop>
          </>
        )}
        {agent.schedule && (
          <Prop icon={<ClockIcon />} label="Works">
            {agent.schedule}
            {nextJob && (
              <span className="text-muted-foreground">· Next: {nextJob}</span>
            )}
          </Prop>
        )}
        {!outside && (
          <>
            {act.toggleConnector && (
              <Prop icon={<PlugIcon />} label="Connectors">
                <Connectors
                  connectors={data.connectors}
                  agentId={agent.id}
                  agentName={agent.name}
                  go={go}
                  toggle={act.toggleConnector}
                />
              </Prop>
            )}
            {agent.skills && (
              <Prop icon={<BookOpenIcon />} label="Skills">
                {agent.skills.map((s) => (
                  <span key={s} className={PILL}>
                    {s}
                  </span>
                ))}
              </Prop>
            )}
            {agent.spend && (
              <Prop icon={<CoinsIcon />} label="Spend">
                <Meter
                  value={(agent.spend.used / agent.spend.cap) * 100}
                  className="w-[90px]"
                />
                <span className="text-[14px] text-foreground">
                  ${fmt(agent.spend.used)} of ${agent.spend.cap} this{" "}
                  {agent.spend.period}
                </span>
              </Prop>
            )}
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

      {/* No week numbers: the ticket list stands alone under its own name. */}
      {(agent.week || tickets.length > 0) && (
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
      )}

      {!outside && (
        <AgentSchedules data={data} go={go} act={act} agentId={agent.id} />
      )}

      {!outside && (
        <>
          {agent.instructions.length > 0 && (
            <>
              <Section title="Instructions" />
              <div className="space-y-2.5 border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] leading-relaxed text-foreground">
                {agent.instructions.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </>
          )}
          {agent.suggestion && ceo && (
            <div
              className={cn(
                agent.instructions.length > 0 ? "mt-3" : "mt-10",
                "flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[13.5px] dark:border-sky-400/25 dark:bg-sky-400/10",
              )}
            >
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
              {(act.dismissRule || act.acceptRule) && (
                <div className="flex shrink-0 gap-2">
                  {act.dismissRule && (
                    <Btn small onClick={() => act.dismissRule?.(agent.id)}>
                      Dismiss
                    </Btn>
                  )}
                  {act.acceptRule && (
                    <Btn
                      small
                      primary
                      onClick={() => act.acceptRule?.(agent.id)}
                    >
                      Accept
                    </Btn>
                  )}
                </div>
              )}
            </div>
          )}

          {agent.memory && (
            <>
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
