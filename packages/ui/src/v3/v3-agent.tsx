import {
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  IdCardIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";
import { Connectors, PILL } from "./v3-agent-connectors";
import {
  DescriptionField,
  EditButton,
  HeldModel,
  InstructionsField,
  ModelField,
  NameField,
  NotificationsRow,
  RoleField,
  SaveButtons,
  useAgentEditor,
} from "./v3-agent-edit";
import { RemoveAgent } from "./v3-agent-remove";
import { Memory, RuleSuggestion } from "./v3-agent-rules";
import { AgentWeek } from "./v3-agent-week";
import { ago, Btn, Meter, Page, Prop, Section, Title } from "./v3-bits";
import { EscLayer, useFocusBack } from "./v3-keys";
import { AgentAvatar, Avatar, CeoMark, StatusPill } from "./v3-marks";
import { agentOf, agentStatus, agentThread, agentTicket } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ThreadRow } from "./v3-rows";
import { soonestNext } from "./v3-schedule-text";
import { AgentSchedules } from "./v3-schedules";
import type { V3Agent, V3ConnectorDef } from "./v3-types";

/* One agent, like a person's profile in Notion: what it does, what it runs
   on, what it has been plugged into, and how far to trust it this week. An
   outside worker gets the same page minus everything LilOS runs (runtime,
   model, skills, spend, instructions, memory): LilOS only watches it.
   What the app cannot tell (runtime, schedule, skills, spend, memory, week)
   or cannot change (connectors, rules, the CEO position, editing, removing)
   is left out, never shown as a made-up value or a dead control. Editing
   and removing live in v3-agent-edit / v3-agent-remove. */

const STATE_WORD: Record<V3ConnectorDef["state"], string> = {
  ready: "Ready",
  "signed-out": "Not signed in",
  missing: "Not found",
};

export function V3AgentPage(props: V3PageProps & { id: string }) {
  const agent = agentOf(props.data, props.id);
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
  return <AgentView {...props} agent={agent} />;
}

function AgentView({ data, go, act, agent }: V3PageProps & { agent: V3Agent }) {
  const ed = useAgentEditor(data, agent, act);
  const draft = ed?.draft;
  // Saving or cancelling swaps the fields back for Edit: the keyboard goes there.
  const editButton = useFocusBack<HTMLButtonElement>(!!draft);
  const outside = agent.kind === "outside";
  const via = outside
    ? data.connectors.find((c) => c.id === agent.via)
    : undefined;
  const status = agentStatus(data, agent.id);
  const current = status === "idle" ? undefined : agentTicket(data, agent.id);
  const live =
    status === "idle" || current ? undefined : agentThread(data, agent.id);
  const tickets = data.tickets.filter((t) => t.owner === agent.id);
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  const ceo = data.agents.find((a) => a.id === data.ceoId);
  const holdsCeo = !!ceo && agent.id === ceo.id;
  // D-#775: reportsTo names an employee. Absent, or an id that is gone,
  // means the owner — the profile name, never "You" or a hardcoded one.
  const manager = agent.reportsTo
    ? data.agents.find((a) => a.id === agent.reportsTo)
    : undefined;
  const reportsTo = `reports to ${manager?.name ?? data.me}`;
  /* The hire dialog seeds the role from the profile's description, so on a
     real agent they are often the same sentence. Said once: the line under
     the name keeps it, and the kicker above carries only the rest. */
  const roleIsDescription =
    !!agent.description &&
    agent.role.trim().toLowerCase() === agent.description.trim().toLowerCase();
  const dotted = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const hired = `hired ${agent.hired}`;
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
              outside ? (
                dotted(
                  "Outside worker",
                  `via ${via?.label ?? "a connector"}`,
                  reportsTo,
                )
              ) : draft && ed ? (
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <RoleField ed={ed} draft={draft} />
                  {` · ${dotted(reportsTo, hired)}`}
                </span>
              ) : (
                dotted(roleIsDescription ? "" : agent.role, reportsTo, hired)
              )
            }
          >
            {draft && ed ? (
              <NameField ed={ed} draft={draft} />
            ) : (
              <>
                {agent.name}
                {holdsCeo && <CeoMark className="ml-2.5 align-middle" />}
              </>
            )}
          </Title>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {draft && ed ? (
            <SaveButtons ed={ed} />
          ) : (
            <>
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
              {ed && <EditButton ref={editButton} onClick={ed.start} />}
            </>
          )}
        </div>
      </div>
      {/* Esc closes the editing, not the peek behind it. */}
      {draft && ed && <EscLayer onEscape={ed.cancel} />}

      {draft && ed?.canDescription ? (
        <div className="mt-1">
          <DescriptionField ed={ed} draft={draft} />
        </div>
      ) : (
        agent.description &&
        !(draft && roleIsDescription) && (
          <p className="mb-1 text-[14.5px] text-muted-foreground leading-relaxed">
            {agent.description}
          </p>
        )
      )}
      {ed && <HeldModel ed={ed} />}

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
          ) : live ? (
            <button
              type="button"
              onClick={() => go({ page: "thread", id: live.id })}
              className="truncate text-foreground underline-offset-2 hover:underline"
            >
              {live.title}
            </button>
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
            {/* Which engine profile the agent runs: its persona, memory and
               skills live there, not in the company record. */}
            {agent.profile && (
              <Prop icon={<IdCardIcon />} label="Profile">
                <span className="font-mono text-[13px] text-foreground">
                  {agent.profile}
                </span>
              </Prop>
            )}
            <Prop icon={<SparklesIcon />} label="Model">
              {draft && ed?.canModel ? (
                <ModelField ed={ed} draft={draft} choices={data.modelChoices} />
              ) : (
                agent.model
              )}
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
        {!outside && <NotificationsRow agent={agent} act={act} />}
      </div>

      {outside && (
        <p className="mt-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-3 py-2.5 text-[13.5px] text-muted-foreground leading-relaxed">
          An outside bot, not a LilOS agent. Its steps come through the{" "}
          {via?.label ?? "connector"} connector; LilOS shows them but does not
          run it.
        </p>
      )}

      <AgentWeek data={data} go={go} agent={agent} tickets={tickets} />

      {!outside && (
        <AgentSchedules data={data} go={go} act={act} agentId={agent.id} />
      )}

      {!outside && (
        <>
          {draft && ed?.canInstructions ? (
            <InstructionsField ed={ed} draft={draft} />
          ) : (
            agent.instructions.length > 0 && (
              <>
                <Section title="Instructions" />
                <div className="space-y-2.5 border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] leading-relaxed text-foreground">
                  {agent.instructions.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
              </>
            )
          )}
          {agent.suggestion && ceo && (
            <RuleSuggestion
              data={data}
              agent={agent}
              ceo={ceo}
              act={act}
              gap={agent.instructions.length > 0 ? "mt-3" : "mt-10"}
            />
          )}

          {agent.memory && <Memory memory={agent.memory} />}
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

      {/* Quiet and last: taking someone off the team is not what this page is
          for. The CEO position holder stays until the position moves. */}
      {!outside && !holdsCeo && (
        <RemoveAgent data={data} go={go} act={act} agent={agent} />
      )}
    </Page>
  );
}
