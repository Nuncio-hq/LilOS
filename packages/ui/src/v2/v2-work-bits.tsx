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
import { RUNTIME_NAME, RuntimeIcon } from "./v2-runtime";
import type { V2Agent } from "./v2-types";
import type {
  V2Assignee,
  V2Connector,
  V2Mark,
  V2TicketState,
} from "./v2-work-types";

/* Pieces the Work board, the ticket sheet and the CEO dock share: the five
   ticket states, and who holds a ticket. A LilOS agent and an outside bot
   must read differently at a glance: an agent is its orb with its runtime
   logo; an outside bot is its provider's mark (supplied by the connector)
   with the provider's name. */

export const TICKET_STATE: Record<
  V2TicketState,
  { label: string; icon: typeof CircleDotIcon; cls: string; bar: string }
> = {
  todo: {
    label: "To do",
    icon: CircleDashedIcon,
    cls: "text-muted-foreground",
    bar: "bg-foreground/15",
  },
  working: {
    label: "Working",
    icon: CircleDotIcon,
    cls: "text-work",
    bar: "bg-work",
  },
  needs: {
    label: "Needs you",
    icon: HandIcon,
    cls: "text-amber-500",
    bar: "bg-amber-500",
  },
  checking: {
    label: "Checking",
    icon: ScanEyeIcon,
    cls: "text-violet-500",
    bar: "bg-violet-500",
  },
  done: {
    label: "Done",
    icon: CircleCheckBigIcon,
    cls: "text-emerald-500",
    bar: "bg-emerald-500",
  },
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

/** A provider's mark on a tile in its colour; a plug when it has none. */
export function ProviderMark({
  mark,
  color,
  label,
  className,
}: {
  mark?: V2Mark;
  color?: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-[6px] bg-background ring-1 ring-foreground/10",
        className,
      )}
    >
      {mark ? (
        <svg
          viewBox={mark.viewBox}
          aria-hidden
          className={cn("size-[70%]", !color && "text-foreground")}
          style={color ? { color } : undefined}
        >
          <path d={mark.d} fill="currentColor" />
        </svg>
      ) : (
        <PlugIcon className="size-[60%] text-muted-foreground" />
      )}
    </span>
  );
}

/** Everything a surface needs to show who holds a ticket. */
export type WorkerIdentity = {
  name: string;
  /** "Hermes · Claude Opus 5.5" or "Acme Bot · outside". */
  kind: string;
  outside: boolean;
  connector?: V2Connector;
  agent?: V2Agent;
};

export function workerIdentity(
  a: V2Assignee,
  agents: V2Agent[],
  connectors: V2Connector[],
): WorkerIdentity {
  if (a.kind === "agent") {
    const agent = agents.find((x) => x.id === a.agentId);
    return {
      name: agent?.name ?? "Agent",
      kind: agent
        ? `${RUNTIME_NAME[agent.runtime]}${agent.model ? ` · ${agent.model}` : ""}`
        : "Agent",
      outside: false,
      agent,
    };
  }
  const connector = connectors.find((c) => c.id === a.connectorId);
  return {
    name: a.name,
    kind: `${connector?.label ?? a.connectorId} · outside`,
    outside: true,
    connector,
  };
}

/* The avatar of whoever holds a ticket. An agent: its orb, with its runtime
   logo in the corner. An outside bot: the provider's mark as the avatar
   itself, in the provider's colour, so one provider's bot never looks like
   another's or like a LilOS agent. */
export function WorkerAvatar({
  who,
  size = "sm",
}: {
  who: WorkerIdentity;
  size?: "sm" | "md" | "lg";
}) {
  const box = size === "lg" ? "size-10" : size === "md" ? "size-7" : "size-5";
  const badge =
    size === "lg"
      ? "size-4 rounded-[5px]"
      : size === "md"
        ? "size-3.5 rounded-[4px]"
        : "size-3 rounded-[3px]";
  if (who.outside)
    return (
      <span className="relative shrink-0">
        <ProviderMark
          mark={who.connector?.mark}
          color={who.connector?.color}
          label={who.connector?.label ?? "Outside"}
          className={cn(box, "rounded-full")}
        />
      </span>
    );
  return (
    <span className="relative shrink-0">
      <HermesAvatar name={who.name} className={box} />
      {who.agent && (
        <RuntimeIcon
          runtime={who.agent.runtime}
          className={cn("absolute -right-1 -bottom-1", badge)}
        />
      )}
    </span>
  );
}

/** Avatar + name, with the kind on a second line or as a chip. */
export function WorkerLabel({
  who,
  size = "sm",
  detail = "chip",
}: {
  who: WorkerIdentity;
  size?: "sm" | "md" | "lg";
  /** "chip": provider label after the name; "line": kind on a second line. */
  detail?: "chip" | "line" | "none";
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <WorkerAvatar who={who} size={size} />
      {detail === "line" ? (
        <span className="min-w-0">
          <span className="block truncate font-medium text-[13px]">
            {who.name}
          </span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {who.kind}
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] text-foreground/85">
            {who.name}
          </span>
          {detail === "chip" && who.outside && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 font-medium text-[10.5px]",
                !who.connector?.color &&
                  "bg-foreground/[0.08] text-foreground/80",
              )}
              style={
                who.connector?.color
                  ? {
                      color: who.connector.color,
                      background: `color-mix(in oklch, ${who.connector.color} 12%, transparent)`,
                    }
                  : undefined
              }
            >
              {who.connector?.label}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
