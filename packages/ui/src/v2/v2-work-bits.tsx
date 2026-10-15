import {
  CircleCheckBigIcon,
  CircleDashedIcon,
  CircleDotIcon,
  HandIcon,
  PlugIcon,
  ScanEyeIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { V2Agent } from "./v2-types";
import type { V2Assignee, V2Connector, V2TicketState } from "./v2-work-types";

/* Small pieces the Work board and the ticket sheet share: the five ticket
   states as icon + word, and an assignee as orb + name with a plug badge
   when it is an outside worker. */

export const TICKET_STATE: Record<
  V2TicketState,
  { label: string; icon: typeof CircleDotIcon; cls: string }
> = {
  todo: {
    label: "To do",
    icon: CircleDashedIcon,
    cls: "text-muted-foreground",
  },
  working: { label: "Working", icon: CircleDotIcon, cls: "text-work" },
  needs: { label: "Needs you", icon: HandIcon, cls: "text-amber-500" },
  checking: { label: "Checking", icon: ScanEyeIcon, cls: "text-violet-500" },
  done: { label: "Done", icon: CircleCheckBigIcon, cls: "text-emerald-500" },
};

export function TicketStateIcon({
  state,
  className,
}: {
  state: V2TicketState;
  className?: string;
}) {
  const s = TICKET_STATE[state];
  return (
    <s.icon
      role="img"
      aria-label={s.label}
      className={cn("size-3.5 shrink-0", s.cls, className)}
    />
  );
}

/** "HB Marketing" + its connector, or a LilOS agent's name. */
export function assigneeName(
  a: V2Assignee,
  agents: V2Agent[],
): { name: string; connector?: string } {
  return a.kind === "agent"
    ? { name: agents.find((x) => x.id === a.agentId)?.name ?? "Agent" }
    : { name: a.name, connector: a.connectorId };
}

/* Orb + name. An outside worker gets a small plug badge on its orb and its
   connector's name on hover, so a glance tells it apart from a LilOS agent
   without naming any provider in LilOS code. */
export function AssigneeBadge({
  a,
  agents,
  connectors,
  size = "sm",
  showName = true,
}: {
  a: V2Assignee;
  agents: V2Agent[];
  connectors: V2Connector[];
  size?: "sm" | "md";
  showName?: boolean;
}) {
  const { name, connector } = assigneeName(a, agents);
  const via = connectors.find((c) => c.id === connector)?.name;
  const orb = size === "md" ? "size-7" : "size-5";
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      title={via ? `${name} · outside, through ${via}` : name}
    >
      <span className="relative shrink-0">
        <HermesAvatar name={name} className={orb} />
        {via && (
          <span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-background ring-1 ring-foreground/15">
            <PlugIcon className="size-2.5 text-muted-foreground" />
          </span>
        )}
      </span>
      {showName && (
        <span className="min-w-0 truncate text-[12px] text-foreground/80">
          {name}
        </span>
      )}
    </span>
  );
}
