import {
  CornerDownRightIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  TargetIcon,
} from "lucide-react";
import { ago, StateDot } from "./v2-bits";
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

/* One ticket, in the side sheet. First: who holds it, unmistakably (a LilOS
   agent with its runtime and model, or an outside bot with its provider's
   mark and name, and which connector its live steps come through). Then the
   ask if one waits on the owner, then the live trail. Last: talk to the CEO
   about it, in the session that already discusses it or in a new one; the
   message carries the ticket so the CEO knows what it is about. */
export function V2TicketDetail({
  t,
  goal,
  agents,
  connectors,
  projects,
  onApprove,
  onDeny,
  sessions = [],
  onAskCeo,
}: {
  t: V2Ticket;
  goal?: V2Goal;
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  onApprove: () => void;
  onDeny: () => void;
  /** CEO sessions that already talk about this ticket, newest first. */
  sessions?: V2Thread[];
  /** Ask the CEO about this ticket: in a session (id), or a new one (null). */
  onAskCeo?: (sessionId: string | null) => void;
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

      {onAskCeo && (
        <section className="flex flex-col gap-2 border-foreground/[0.07] border-t pt-4">
          <h4 className="font-semibold text-[12px] text-muted-foreground uppercase tracking-[0.06em]">
            Talk to the CEO about {t.id}
          </h4>
          {sessions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onAskCeo(s.id)}
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-left ring-1 ring-foreground/10 hover:bg-foreground/[0.04]"
            >
              {i === 0 ? (
                <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">
                  {i === 0 ? "Continue in " : ""}
                  <span className="font-medium">{s.title}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <StateDot state={s.state} />
                  {s.line ?? "Session"} · {ago(s.ago)}
                </span>
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onAskCeo(null)}
            className="flex h-9 items-center gap-2.5 rounded-xl border border-foreground/15 border-dashed px-3 text-[12.5px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <MessageSquarePlusIcon className="size-3.5" />
            New session about {t.id}
          </button>
          {t.ask && !t.ask.risk && (
            <p className="text-[11.5px] text-muted-foreground">
              {t.ask.ceoAnswer
                ? `The CEO already answered: "${t.ask.ceoAnswer}"`
                : "The worker asked a routine question; the CEO answers it."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
