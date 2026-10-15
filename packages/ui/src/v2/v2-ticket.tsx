import { ChevronDownIcon, TargetIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { StateDot } from "./v2-bits";
import { CeoConversation, CeoIdentity, CeoSessionPicker } from "./v2-ceo-chat";
import { V2Trail } from "./v2-trail";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import {
  TICKET_STATE,
  TicketStateIcon,
  WorkerLabel,
  workerIdentity,
} from "./v2-work-bits";
import type { V2Connector, V2Goal, V2Ticket } from "./v2-work-types";

const RISK: Record<NonNullable<V2Ticket["ask"]>["risk"] & string, string> = {
  "spends-money": "Spends money",
  "sends-outside": "Sends something outside",
  "dangerous-command": "Dangerous command",
};

/* One ticket, in the side sheet: the ticket on top (who holds it, the
   ask if one waits on the owner, the live trail), the CEO underneath. */
export function V2TicketDetail({
  t,
  goal,
  agents,
  connectors,
  projects,
  onApprove,
  onDeny,
}: {
  t: V2Ticket;
  goal?: V2Goal;
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  onApprove: () => void;
  onDeny: () => void;
}) {
  const pi = projects.findIndex((p) => p.id === t.projectId);
  const who = workerIdentity(t.assignee, agents, connectors);
  const tint = who.connector?.color;
  return (
    <div className="flex flex-col gap-5 px-5 pt-1 pb-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground">
            <TicketStateIcon state={t.state} />
            {TICKET_STATE[t.state].label}
          </span>
          <span className="flex items-center gap-1.5">
            <ProjectChip
              name={projects[pi]?.name ?? "No project"}
              index={pi}
              className="size-4 text-[8px]"
            />
            {projects[pi]?.name}
          </span>
          {goal && (
            <span className="flex min-w-0 items-center gap-1.5">
              <TargetIcon className="size-3.5 shrink-0" />
              <span className="truncate">{goal.title}</span>
            </span>
          )}
        </div>
        <h3 className="text-balance font-semibold text-[17px] leading-snug">
          {t.title}
        </h3>
        <div
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-foreground/[0.07]"
          style={
            tint
              ? {
                  background: `color-mix(in oklch, ${tint} 7%, transparent)`,
                }
              : undefined
          }
        >
          <WorkerLabel who={who} size="md" detail="line" />
          <span className="ml-auto shrink-0 text-right text-[11.5px] text-muted-foreground leading-tight">
            {who.outside ? (
              <>
                Outside bot
                <br />
                via{" "}
                <code className="font-mono text-foreground/80">
                  {who.connector?.name}
                </code>{" "}
                {who.connector?.kind.toUpperCase()}
              </>
            ) : (
              <>
                LilOS agent
                {who.agent?.role && (
                  <>
                    <br />
                    {who.agent.role}
                  </>
                )}
              </>
            )}
          </span>
        </div>
      </div>

      {t.ask?.risk && (
        <div className="rounded-2xl bg-amber-500/[0.08] p-4 ring-1 ring-amber-500/25">
          <div className="flex items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300">
            <StateDot state="needs" />
            {RISK[t.ask.risk]} · the CEO sent it to you
          </div>
          <p className="mt-1.5 font-medium text-[14.5px] leading-snug">
            {t.ask.text}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="h-8 rounded-full bg-foreground px-4 font-medium text-[13px] text-background active:scale-[0.97]"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={onDeny}
              className="h-8 rounded-full px-3 text-[13px] text-foreground/80 hover:bg-foreground/[0.05]"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      <section>
        <h4 className="mb-3 flex items-center gap-2 font-semibold text-[12px] text-muted-foreground uppercase tracking-[0.06em]">
          Live
          {who.outside && (
            <span className="font-normal normal-case tracking-normal">
              · steps reported by {who.connector?.label}
            </span>
          )}
        </h4>
        <V2Trail lines={t.trail} />
      </section>

      {t.ask && !t.ask.risk && t.ask.ceoAnswer && (
        <p className="rounded-lg bg-foreground/[0.035] px-3 py-2 text-[12px] text-muted-foreground">
          {who.name} asked "{t.ask.text}". The CEO answered: "{t.ask.ceoAnswer}"
        </p>
      )}
    </div>
  );
}

/* The CEO, at the bottom of a ticket's sheet: who it is, which
   conversation (the one that opened the ticket or already talks about it,
   any other, or a new one about this ticket), and the chat itself. A message
   sent here is about this ticket. Collapses to one line so the trail gets
   the room when the owner is only reading. */
export function TicketCeoChat({
  ticketId,
  ceo,
  sessions,
  goals,
  sessionId,
  ticketIds,
  onSession,
  onNewSession,
  onSend,
  onTicket,
}: {
  ticketId: string;
  ceo: V2Agent;
  /** The CEO's conversations; ones about this ticket first. */
  sessions: V2Thread[];
  goals: V2Goal[];
  sessionId?: string;
  ticketIds: string[];
  onSession: (id: string) => void;
  onNewSession: () => void;
  onSend: (text: string) => void;
  onTicket: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const thread = sessions.find((s) => s.id === sessionId);
  return (
    <section
      aria-label="Chat with the CEO"
      className={cn(
        "flex shrink-0 flex-col border-foreground/[0.08] border-t bg-foreground/[0.02]",
        open && "h-[min(52%,460px)]",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <CeoIdentity ceo={ceo} busy={thread?.state === "working"} size="sm" />
          <span className="truncate text-[12px] text-muted-foreground">
            about {ticketId}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse the CEO chat" : "Open the CEO chat"}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", !open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <>
          <div className="shrink-0 px-2 pb-1">
            <CeoSessionPicker
              sessions={sessions}
              goals={goals}
              value={sessionId}
              onPick={onSession}
              onNew={onNewSession}
              compact
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-foreground/[0.06] border-t">
            <CeoConversation
              ceo={ceo}
              thread={thread}
              ticketIds={ticketIds}
              about={{ id: ticketId, title: "" }}
              hideAbout
              onTicket={onTicket}
              onSend={onSend}
              emptyHint={`Ask the CEO about ${ticketId}`}
            />
          </div>
        </>
      )}
    </section>
  );
}
