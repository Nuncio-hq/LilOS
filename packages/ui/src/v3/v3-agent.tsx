import {
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  EllipsisIcon,
  GaugeIcon,
  PencilIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { Connectors, PILL } from "./v3-agent-connectors";
import {
  EffortProp,
  InlineText,
  InstructionsBlock,
  ModelProp,
  NotificationsRow,
  useFieldSave,
} from "./v3-agent-edit";
import { AgentNotes } from "./v3-agent-notes";
import { RemoveAgent } from "./v3-agent-remove";
import { RuleSuggestion } from "./v3-agent-rules";
import { AgentSkills } from "./v3-agent-skills";
import { AgentWeek } from "./v3-agent-week";
import { ago, Btn, Meter, Page, Prop, Section, Title } from "./v3-bits";
import { useFocusBack, useMenu } from "./v3-keys";
import { AgentAvatar, Avatar, CeoMark, StatusPill } from "./v3-marks";
import {
  agentOf,
  agentPageFields,
  agentStatus,
  agentThread,
  agentTicket,
  companyOn,
  effortLadderOf,
  modelChoicesOf,
  removable,
  runtimeLabelOf,
  runtimeOf,
  schedulesOff,
} from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { soonestNext } from "./v3-schedule-text";
import { AgentSchedules } from "./v3-schedules";
import { TitleInput } from "./v3-thread-menu";
import { ThreadRow } from "./v3-threads-rows";
import type { V3Agent, V3ConnectorDef } from "./v3-types";

/* One agent, like a person's profile in Notion: its name, what it is for,
   the model it thinks with and its standing brief — plus schedules,
   notifications and its threads. An outside worker gets the same page
   minus everything LilOS runs (model, skills, spend, instructions, notes):
   LilOS only watches it. What the app cannot tell or cannot change is left
   out, never shown as a made-up value or a dead control — and internals
   (the runtime id, the engine's profile name, the hire date) never show:
   the runtime speaks through the avatar's look instead (#872).

   There is no edit mode (#872): the name, description and instructions
   each edit in place and save themselves; the model saves the moment it
   is picked. Fields the agent's runtime cannot write — the ones its
   engine's `updatable` does not name (D-#761) — render as plain text, and
   Instructions and Schedules say why they sit read-only or can't fire.
   Make CEO is the owner's way to move the position (D-#778), including
   the first time there is no holder yet. */

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
  const outside = agent.kind === "outside";
  /* The app can write this agent's record at all (#856). Engine-owned
     fields gate a level deeper, on the owning runtime's `updatable`. */
  const canEdit = !outside && !!act.updateAgent;
  /* One save pipeline per field — each edits and reports on its own. */
  const descSave = useFieldSave(act, agent.id);
  const modelSave = useFieldSave(act, agent.id);
  const effortSave = useFieldSave(act, agent.id);
  const instrSave = useFieldSave(act, agent.id);
  /* Click-to-rename (#870): the name itself, or ⋯ → Rename, swaps it for a
     box; Enter (or leaving) saves just the name, Esc keeps the old one. */
  const [renaming, setRenaming] = useState(false);
  const nameButton = useFocusBack<HTMLButtonElement>(renaming);
  const rename = canEdit
    ? {
        save: (name: string) =>
          void act.updateAgent?.(agent.id, { name }).catch(() => {}),
        start: () => setRenaming(true),
      }
    : undefined;
  const via = outside
    ? data.connectors.find((c) => c.id === agent.via)
    : undefined;
  /* With the company layer paused (D-#836) this page is a person, not a
     team member: no position moves, no reports-to, no ticket it holds, no
     week board or spend — those facts stay in the data. */
  const company = companyOn(data);
  /* The ticket-mode "Now" row (company layer only — the paused layer's page
     has no idle row, #872): what it is on, from the ticket or the live
     thread, else what it is next to do. */
  const status = agentStatus(data, agent.id);
  const current =
    !company || status === "idle" ? undefined : agentTicket(data, agent.id);
  const live =
    status === "idle" || current ? undefined : agentThread(data, agent.id);
  const tickets = company
    ? data.tickets.filter((t) => t.owner === agent.id)
    : [];
  const threads = data.threads.filter((t) => t.agentId === agent.id);
  const ceo = data.agents.find((a) => a.id === data.ceoId);
  const holdsCeo = !!ceo && agent.id === ceo.id;
  // D-#775: reportsTo names an employee. Absent, or an id that is gone,
  // means the owner — the profile name, never "You" or a hardcoded one.
  // Company layer only: the paused layer has no org to report into.
  const manager = agent.reportsTo
    ? data.agents.find((a) => a.id === agent.reportsTo)
    : undefined;
  const reportsTo = company ? `reports to ${manager?.name ?? data.me}` : "";
  /* The role line (company layer): the hire dialog seeds the role from the
     profile's description, so said once — the description line keeps it. */
  const roleIsDescription =
    !!agent.description &&
    agent.role.trim().toLowerCase() === agent.description.trim().toLowerCase();
  const dotted = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));
  // The soonest scheduled job that is not paused: Works says when it is due.
  const nextJob = outside
    ? undefined
    : soonestNext(data.schedules.filter((s) => s.agentId === agent.id));

  /* #872 — the page says what a person needs: a name, what it's for, the
     model it thinks with, its standing brief. Where it runs is for the
     avatar's look and the fields its runtime lets LilOS write — never a
     jargon row ("acp:devin", "Profile: claude", "hired Oct 27" all went).
     `rt` absent (no runtimes known) leaves the default engine's world. */
  const rt = outside ? undefined : runtimeOf(data, agent);
  const runsOn = outside ? undefined : runtimeLabelOf(data, agent);
  const fields = agentPageFields(data, agent);
  const canDescription = canEdit && fields.includes("description");
  const canModel = canEdit && fields.includes("model");
  const canInstructions = canEdit && fields.includes("instructions");
  /* The effort pin is the relay record's — editable wherever the agent is
     (no engine updatable flag); the row only exists when the runtime
     reports levels for the agent's model. */
  const effortLadder = canEdit ? effortLadderOf(data, agent) : undefined;
  /* Whether the app positively knows this engine's field list — it can say
     why a field sits read-only, not just sit it. */
  const fieldsKnown =
    rt && !rt.isDefault
      ? rt.updatable !== undefined
      : data.agentFields !== undefined;
  const schedulesWhy = outside ? undefined : schedulesOff(data, agent);
  /* Notes and the skill toggles need both the records and a handler. The
     real app has neither yet, so those sections stay off the page (D-#19). */
  const notes =
    !outside && agent.notes && act.saveNote ? agent.notes : undefined;
  const skillEditor = !outside && data.skills && act.setAgentSkill;

  return (
    <Page wide>
      <div className="flex items-center gap-4">
        <AgentAvatar data={data} agent={agent} size={56} />
        <div className="min-w-0 flex-1">
          <Title
            kicker={
              outside
                ? dotted(
                    "Outside worker",
                    `via ${via?.label ?? "a connector"}`,
                    reportsTo,
                  )
                : company
                  ? dotted(roleIsDescription ? "" : agent.role, reportsTo) ||
                    undefined
                  : undefined
            }
          >
            {renaming && rename ? (
              <TitleInput
                value={agent.name}
                ariaLabel="Agent name"
                onSave={rename.save}
                onDone={(byKey) => {
                  setRenaming(false);
                  if (byKey) nameButton.current?.focus();
                }}
                className="h-[1.2em]"
              />
            ) : (
              <>
                {rename ? (
                  <button
                    ref={nameButton}
                    type="button"
                    title="Rename"
                    onClick={rename.start}
                    className="-mx-1 rounded-[5px] px-1 text-left outline-none transition-colors hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]"
                  >
                    {agent.name}
                  </button>
                ) : (
                  agent.name
                )}
                {holdsCeo && <CeoMark className="ml-2.5 align-middle" />}
              </>
            )}
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
          {!outside && !holdsCeo && company && act.makeCeo && (
            <button
              type="button"
              title={`Move the CEO position to ${agent.name}`}
              onClick={() => act.makeCeo?.(agent.id)}
              className="h-7 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
            >
              Make CEO
            </button>
          )}
          {rename && <AgentMenu onRename={rename.start} />}
        </div>
      </div>

      {canDescription ? (
        <div className="mt-1 mb-1">
          <InlineText
            value={agent.description ?? ""}
            placeholder="What it is for, in a line"
            ariaLabel="Description"
            save={descSave}
            onCommit={(v) => void descSave?.run({ description: v })}
            className="text-[14.5px] text-muted-foreground leading-relaxed"
          />
        </div>
      ) : (
        agent.description && (
          <p className="mb-1 text-[14.5px] text-muted-foreground leading-relaxed">
            {agent.description}
          </p>
        )
      )}

      <div className="mt-3">
        {company && (
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
              <span className="truncate text-foreground">{live.title}</span>
            ) : (
              <span className="text-muted-foreground">
                {agent.next ?? "Nothing assigned"}
              </span>
            )}
          </Prop>
        )}
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
          <ModelProp
            icon={<SparklesIcon />}
            agent={agent}
            choices={modelChoicesOf(data, agent)}
            save={canModel ? modelSave : undefined}
          />
        )}
        {/* #872: the standing effort pick — only where the runtime reports
            levels for the agent's model; the pin is the relay record's,
            relay-owned so it needs no engine updatable flag. */}
        {effortLadder && (
          <EffortProp
            icon={<GaugeIcon />}
            agent={agent}
            ladder={effortLadder}
            save={effortSave}
          />
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
            {/* Names only, when the app cannot attach or detach. */}
            {!skillEditor && agent.skills && agent.skills.length > 0 && (
              <Prop icon={<BookOpenIcon />} label="Skills">
                {agent.skills.map((s) => (
                  <span key={s} className={PILL}>
                    {s}
                  </span>
                ))}
              </Prop>
            )}
            {company && agent.spend && (
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

      {company && (
        <AgentWeek data={data} go={go} agent={agent} tickets={tickets} />
      )}

      {!outside && (
        <AgentSchedules
          data={data}
          go={go}
          act={act}
          agentId={agent.id}
          unavailable={schedulesWhy}
        />
      )}

      {!outside && (
        <>
          <InstructionsBlock
            paragraphs={agent.instructions}
            editable={canInstructions}
            locked={
              canEdit && !canInstructions && fieldsKnown
                ? `LilOS can't change these on ${runsOn ?? "this engine"}`
                : undefined
            }
            save={instrSave}
            onCommit={(text) => void instrSave?.run({ instructions: text })}
          />
          {notes && (
            <AgentNotes
              notes={notes}
              onSave={(note) => act.saveNote?.(agent.id, note)}
            />
          )}
          {skillEditor && data.skills && (
            <AgentSkills
              skills={data.skills}
              attached={agent.skills ?? []}
              onToggle={(skillId, attached) =>
                act.setAgentSkill?.(agent.id, skillId, attached)
              }
              onLibrary={() => go({ page: "settings", view: "skills" })}
            />
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
          <ThreadRow
            key={t.id}
            data={data}
            t={t}
            go={go}
            act={act}
            drop="agent"
          />
        ))}
      </div>

      {/* Quiet and last: taking an agent off LilOS is not what this page is
          for. Drawn only for an agent that may go (`removable`): never an
          outside worker, never the CEO while the position shows, never the
          last LilOS agent (#856). */}
      {removable(data, agent) && (
        <RemoveAgent data={data} go={go} act={act} agent={agent} />
      )}
    </Page>
  );
}

/** The agent's ⋯ — quiet actions on the page header; today the other door
   to rename (#870). Same shape as the thread rows' ⋯ menu. */
function AgentMenu({ onRename }: { onRename: () => void }) {
  const menu = useMenu();
  return (
    <span className="relative">
      <button
        ref={menu.trigger}
        type="button"
        onClick={() => menu.setOpen((o) => !o)}
        aria-label="Agent actions"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
      >
        <EllipsisIcon className="size-4" />
      </button>
      {menu.open && (
        <div
          ref={menu.list}
          role="menu"
          onKeyDown={menu.onKeyDown}
          className="absolute top-[calc(100%+6px)] right-0 z-20 w-40 rounded-lg border bg-popover p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              menu.setOpen(false);
              onRename();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-[var(--v3-hover)]"
          >
            <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">Rename</span>
          </button>
        </div>
      )}
    </span>
  );
}
