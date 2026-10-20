import { cn } from "../lib/utils";
import type { V3Data } from "./v3-data-types";
import type { V3Agent, V3Status, V3Tone } from "./v3-types";

/* The marks v3 draws for things: a status pill and dot, an agent's or a
   project's face. One rule: colour belongs to status; avatars and project
   marks are soft pastels, everything else is ink on paper. */

export const STATUS_WORD: Record<V3Status, string> = {
  working: "Working",
  waiting: "Waiting",
  needs: "Needs you",
  stuck: "Stuck",
  idle: "Idle",
  done: "Done",
  planned: "Planned",
  failed: "Failed",
};

const PILL: Record<V3Status, string> = {
  working: "bg-sky-50 text-sky-700 dark:bg-sky-400/12 dark:text-sky-300",
  waiting:
    "bg-yellow-50 text-yellow-700 dark:bg-yellow-400/12 dark:text-yellow-300",
  needs:
    "bg-orange-50 text-orange-700 dark:bg-orange-400/14 dark:text-orange-300",
  stuck: "bg-red-50 text-red-700 dark:bg-red-400/14 dark:text-red-300",
  idle: "bg-stone-100 text-stone-500 dark:bg-stone-400/12 dark:text-stone-400",
  done: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300",
  planned:
    "bg-stone-100 text-stone-500 dark:bg-stone-400/12 dark:text-stone-400",
  failed: "bg-red-50 text-red-700 dark:bg-red-400/14 dark:text-red-300",
};

export const DOT: Record<V3Status, string> = {
  working: "bg-sky-600 dark:bg-sky-400",
  waiting: "bg-yellow-500",
  needs: "bg-orange-500",
  stuck: "bg-red-500",
  idle: "bg-stone-400",
  done: "bg-emerald-600 dark:bg-emerald-400",
  planned: "border border-stone-400 bg-transparent",
  failed: "bg-red-500",
};

/** Status text colour, for numbers and inline words that carry a state. */
export const INK: Record<V3Status, string> = {
  working: "text-sky-700 dark:text-sky-300",
  waiting: "text-yellow-700 dark:text-yellow-300",
  needs: "text-orange-700 dark:text-orange-300",
  stuck: "text-red-600 dark:text-red-300",
  idle: "text-stone-500",
  done: "text-emerald-700 dark:text-emerald-300",
  planned: "text-stone-500",
  failed: "text-red-600 dark:text-red-300",
};

export function StatusPill({
  status,
  label,
  className,
}: {
  status: V3Status;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pr-2.5 pl-2 font-medium text-[12.5px]",
        PILL[status],
        className,
      )}
    >
      <StatusDot status={status} />
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: V3Status;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      // Test hook: the sidebar dot is the per-person status signal (#32).
      data-v3-status={status}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[status],
        status === "working" && "lilos-v3-breathe",
        className,
      )}
    />
  );
}

const TONE: Record<V3Tone, string> = {
  c: "bg-[#f2ebe1] text-[#8a6a3e] dark:bg-[#8a6a3e]/30 dark:text-[#e6cba4]",
  b: "bg-[#e5eef5] text-[#3d6a8c] dark:bg-[#3d6a8c]/35 dark:text-[#a9cbe6]",
  r: "bg-[#eee8f4] text-[#74569a] dark:bg-[#74569a]/35 dark:text-[#cdb8ea]",
  m: "bg-[#f6e9e1] text-[#a2603a] dark:bg-[#a2603a]/35 dark:text-[#ecc0a4]",
  s: "bg-[#e6f0ea] text-[#4a7a5d] dark:bg-[#4a7a5d]/35 dark:text-[#b2d8c0]",
  d: "bg-[#f4e8ee] text-[#9a4f73] dark:bg-[#9a4f73]/35 dark:text-[#e8b6cf]",
  n: "bg-foreground text-background",
};

export function Avatar({
  name,
  tone,
  size = 20,
  className,
  look,
}: {
  name: string;
  tone: V3Tone;
  size?: number;
  className?: string;
  /** An outside worker: its connector's mark on the connector's colour, in
     a rounded square, so a bot never looks like a LilOS agent. */
  look?: { mark: string; color: string };
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (look && look.mark.length > 1 ? 0.4 : 0.5)),
        ...(look ? { background: look.color, color: "#fff" } : {}),
      }}
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold leading-none",
        look ? "rounded-[28%]" : ["rounded-full", TONE[tone]],
        className,
      )}
    >
      {look ? look.mark : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** An agent's face wherever it appears: a LilOS agent's letter on its tone,
   or an outside worker's connector mark. An agent that is gone (its id
   outlived it) shows a neutral "?" instead of another agent's face. */
export function AgentAvatar({
  data,
  agent,
  size,
  className,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  size?: number;
  className?: string;
}) {
  if (!agent)
    return <Avatar name="?" tone="n" size={size} className={className} />;
  const via =
    agent.kind === "outside"
      ? data.connectors.find((c) => c.id === agent.via)
      : undefined;
  return (
    <Avatar
      name={agent.name}
      tone={agent.tone}
      size={size}
      className={className}
      look={via?.look}
    />
  );
}

/** The crown beside whoever holds the CEO position. */
export function CeoMark({ className }: { className?: string }) {
  return (
    <span
      title="Holds the CEO position"
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full bg-amber-100 px-1.5 font-semibold text-[10.5px] text-amber-800 tracking-wide dark:bg-amber-400/15 dark:text-amber-300",
        className,
      )}
    >
      CEO
    </span>
  );
}

/** A small square letter mark for a project. */
export function ProjectMark({
  name,
  tone,
  className,
}: {
  name: string;
  tone: V3Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] font-bold text-[10px]",
        TONE[tone],
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}
