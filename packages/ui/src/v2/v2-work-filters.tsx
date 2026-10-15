import { XIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { RuntimeIcon } from "./v2-runtime";
import type { V2Agent, V2Project } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import {
  ProviderMark,
  type WorkerIdentity,
  workerIdentity,
} from "./v2-work-bits";
import type { V2Connector, V2Ticket } from "./v2-work-types";

/* The Work board's two filters, in one quiet toolbar: projects as a
   segmented control on the left, "who" as a row of round marks on the right
   (LilOS agents by runtime, then each outside provider in its own colour),
   each with its open-ticket count. Icons only until one is picked; the
   picked one opens into mark + name + ×. */

/** One group of workers, as the owner tells them apart. `key` is the filter value. */
export type WorkerGroup = {
  key: string;
  label: string;
  outside: boolean;
  identity: WorkerIdentity;
  members: string[];
  open: number;
};

export const groupKey = (who: WorkerIdentity) =>
  who.outside
    ? `c:${who.connector?.id ?? who.name}`
    : `r:${who.agent?.runtime ?? "hermes"}`;

/* A group's name: the provider's label, else the connector's own name or
   id, never a generic word, so two providers never merge into one chip. */
const groupLabel = (who: WorkerIdentity) =>
  who.outside
    ? (who.connector?.label ?? who.connector?.name ?? who.kind.split(" · ")[0])
    : "LilOS agents";

export function groupsFor(
  tickets: V2Ticket[],
  agents: V2Agent[],
  connectors: V2Connector[],
): WorkerGroup[] {
  const groups = new Map<string, WorkerGroup>();
  for (const t of tickets) {
    const who = workerIdentity(t.assignee, agents, connectors);
    const key = groupKey(who);
    const g = groups.get(key) ?? {
      key,
      label: groupLabel(who),
      outside: who.outside,
      identity: who,
      members: [],
      open: 0,
    };
    if (!g.members.includes(who.name)) g.members.push(who.name);
    if (t.state !== "done") g.open += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.outside) - Number(b.outside),
  );
}

function GroupMark({ g, size }: { g: WorkerGroup; size: string }) {
  return g.outside ? (
    <ProviderMark
      mark={g.identity.connector?.mark}
      icon={g.identity.connector?.icon}
      color={g.identity.connector?.color}
      label={g.label}
      className={cn(size, "rounded-full")}
    />
  ) : (
    <RuntimeIcon
      runtime={g.identity.agent?.runtime ?? "hermes"}
      className={cn(size, "rounded-full")}
    />
  );
}

/** Projects as one segmented control. */
export function ProjectSegments({
  projects,
  value,
  onChange,
}: {
  projects: V2Project[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const seg = (on: boolean) =>
    cn(
      "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors",
      on
        ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-foreground/[0.06] dark:bg-white/[0.1]"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="group"
      aria-label="Project"
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-foreground/[0.05] p-0.5 [scrollbar-width:none]"
    >
      <button
        type="button"
        aria-pressed={!value}
        onClick={() => onChange(null)}
        className={seg(!value)}
      >
        All
      </button>
      {projects.map((p, i) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={value === p.id}
          onClick={() => onChange(value === p.id ? null : p.id)}
          className={seg(value === p.id)}
        >
          <ProjectChip name={p.name} index={i} className="size-4 text-[8px]" />
          {p.name}
        </button>
      ))}
    </div>
  );
}

/* Who: round marks with an open-ticket badge. Hover says who is in the
   group; picking one filters the board and opens the chip into its name. */
export function WhoFilter({
  groups,
  value,
  onChange,
}: {
  groups: WorkerGroup[];
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Who"
      className="flex shrink-0 items-center gap-1.5"
    >
      {groups.map((g, i) => {
        const on = value === g.key;
        const dim = value !== null && !on;
        const tip = `${g.label} · ${g.members.length} ${g.outside ? (g.members.length === 1 ? "bot" : "bots") : g.members.length === 1 ? "agent" : "agents"}, ${g.open} open: ${g.members.join(", ")}`;
        return (
          <span key={g.key} className="flex items-center">
            {i > 0 && g.outside && !groups[i - 1]?.outside && (
              <span aria-hidden className="mr-1.5 h-4 w-px bg-foreground/10" />
            )}
            <button
              type="button"
              aria-pressed={on}
              aria-label={tip}
              title={tip}
              onClick={() => onChange(on ? null : g.key)}
              className={cn(
                "relative flex h-8 items-center gap-1.5 rounded-full transition-all",
                on
                  ? "bg-foreground/[0.07] pr-1.5 pl-1 ring-1 ring-foreground/15"
                  : "p-0.5 hover:bg-foreground/[0.05]",
                dim && "opacity-40 hover:opacity-100",
              )}
            >
              <GroupMark g={g} size="size-7" />
              {!on && g.open > 0 && (
                <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-semibold text-[9.5px] text-background tabular-nums ring-2 ring-[var(--v2-main)]">
                  {g.open}
                </span>
              )}
              {on && (
                <>
                  <span className="font-medium text-[12.5px]">{g.label}</span>
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">
                    {g.open} open
                  </span>
                  <XIcon className="size-3.5 text-muted-foreground" />
                </>
              )}
            </button>
          </span>
        );
      })}
    </div>
  );
}
