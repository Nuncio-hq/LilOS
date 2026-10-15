import { cn } from "../lib/utils";
import type { V2State } from "./v2-types";

/* Small visual pieces that replace sentences: a number with an icon, a
   stacked bar that shows how a set of threads splits by state, a project
   chip. Shared by Home, Agents and Settings. */

/** Icon + number, with the label only as a tooltip. */
export function IconStat({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  tone?: "amber" | "work" | "muted";
}) {
  return (
    <span
      role="img"
      title={label}
      aria-label={`${label}: ${value}`}
      className={cn(
        "inline-flex items-center gap-1 font-medium text-[12px] tabular-nums [&_svg]:size-3.5",
        tone === "amber" && "text-amber-600 dark:text-amber-400",
        tone === "work" && "text-work",
        (!tone || tone === "muted") && "text-muted-foreground",
      )}
    >
      {icon}
      {value}
    </span>
  );
}

const BAR: { state: V2State; cls: string; label: string }[] = [
  { state: "needs", cls: "bg-amber-500", label: "Needs you" },
  { state: "failed", cls: "bg-red-500", label: "Failed" },
  { state: "working", cls: "bg-work", label: "Working" },
  { state: "unseen", cls: "bg-primary", label: "New result" },
  { state: "idle", cls: "bg-foreground/15", label: "Idle" },
];

/** One bar per set of threads: each segment is a state, width = share. */
export function StateBar({
  counts,
  className,
}: {
  counts: Partial<Record<V2State, number>>;
  className?: string;
}) {
  const total = BAR.reduce((n, b) => n + (counts[b.state] ?? 0), 0);
  if (total === 0)
    return (
      <div
        className={cn("h-1.5 rounded-full bg-foreground/[0.06]", className)}
      />
    );
  return (
    <div
      role="img"
      aria-label={BAR.filter((b) => counts[b.state])
        .map((b) => `${counts[b.state]} ${b.label.toLowerCase()}`)
        .join(", ")}
      className={cn(
        "flex h-1.5 gap-[2px] overflow-hidden rounded-full",
        className,
      )}
    >
      {BAR.map((b) =>
        counts[b.state] ? (
          <span
            key={b.state}
            title={`${counts[b.state]} ${b.label.toLowerCase()}`}
            className={cn(
              "h-full first:rounded-l-full last:rounded-r-full",
              b.cls,
            )}
            style={{ flexGrow: counts[b.state] }}
          />
        ) : null,
      )}
    </div>
  );
}

const PROJECT_TINT = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
];

/** A project as a two-letter tile, tinted per project so it reads at a glance.
    A negative index (no project) is grey. */
export function ProjectChip({
  name,
  index,
  className,
}: {
  name: string;
  index: number;
  className?: string;
}) {
  return (
    <span
      title={name}
      aria-label={name}
      role="img"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-[6px] font-semibold text-[9px]",
        index < 0
          ? "bg-foreground/[0.07] text-muted-foreground"
          : PROJECT_TINT[index % PROJECT_TINT.length],
        className,
      )}
    >
      {name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
