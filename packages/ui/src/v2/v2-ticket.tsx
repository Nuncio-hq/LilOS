import { MessagesSquareIcon, PlugIcon, TargetIcon } from "lucide-react";
import { StateDot } from "./v2-bits";
import { V2Trail } from "./v2-trail";
import type { V2Agent, V2Project } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import { AssigneeBadge, TICKET_STATE, TicketStateIcon } from "./v2-work-bits";
import type { V2Connector, V2Goal, V2Ticket } from "./v2-work-types";

const RISK: Record<NonNullable<V2Ticket["ask"]>["risk"] & string, string> = {
  "spends-money": "Spends money",
  "sends-outside": "Sends something outside",
  "dangerous-command": "Dangerous command",
};

/* One ticket, in the side sheet: what it is for, who holds it, the ask if
   one is waiting, then the live trail. The trail is the same for a LilOS
   agent and for an outside worker; for an outside worker it is what the
   connector reports back, not the CEO's summary. */
export function V2TicketDetail({
  t,
  goal,
  agents,
  connectors,
  projects,
  onApprove,
  onDeny,
  onOpenThread,
}: {
  t: V2Ticket;
  goal?: V2Goal;
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  onApprove: () => void;
  onDeny: () => void;
  onOpenThread?: () => void;
}) {
  const pi = projects.findIndex((p) => p.id === t.projectId);
  const via =
    t.assignee.kind === "outside"
      ? connectors.find(
          (c) => c.id === (t.assignee as { connectorId: string }).connectorId,
        )
      : undefined;
  return (
    <div className="flex flex-col gap-5 px-5 pt-1 pb-8">
      <div className="flex flex-col gap-3">
        <h3 className="text-balance font-semibold text-[17px] leading-snug">
          {t.title}
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px]">
          <span className="flex items-center gap-1.5">
            <TicketStateIcon state={t.state} />
            {TICKET_STATE[t.state].label}
          </span>
          <AssigneeBadge
            a={t.assignee}
            agents={agents}
            connectors={connectors}
          />
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ProjectChip
              name={projects[pi]?.name ?? "No project"}
              index={pi}
              className="size-4 text-[8px]"
            />
            {projects[pi]?.name}
          </span>
        </div>
        {goal && (
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <TargetIcon className="size-3.5" />
            {goal.title}
          </div>
        )}
        {via && (
          <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.035] px-3 py-2 text-[12px] text-muted-foreground">
            <PlugIcon className="size-3.5 shrink-0" />
            <span>
              Outside worker. Live steps come through the{" "}
              <code className="font-mono text-foreground/80">{via.name}</code>{" "}
              connector.
            </span>
          </div>
        )}
      </div>

      {t.ask?.risk && (
        <div className="rounded-2xl bg-amber-500/[0.08] p-4 ring-1 ring-amber-500/25">
          <div className="flex items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300">
            <StateDot state="needs" />
            {RISK[t.ask.risk]}
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
        <h4 className="mb-3 font-semibold text-[12px] text-muted-foreground uppercase tracking-[0.06em]">
          Live
        </h4>
        <V2Trail lines={t.trail} />
      </section>

      {onOpenThread && (
        <button
          type="button"
          onClick={onOpenThread}
          className="flex h-9 items-center justify-center gap-2 rounded-xl text-[12.5px] ring-1 ring-foreground/10 hover:bg-foreground/[0.04]"
        >
          <MessagesSquareIcon className="size-3.5" />
          Open the CEO thread
        </button>
      )}
    </div>
  );
}
