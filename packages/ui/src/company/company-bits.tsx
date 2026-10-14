import { cn } from "../lib/utils";
import type { Bot, BotProvider, BotState, TicketState } from "./company-types";

/* Provider identity: a short label and a colour, so a glance tells Grok Bot
   work from Muse work. Not the providers' logos (trademarks). */
export const PROVIDER: Record<
  BotProvider,
  { label: string; maker: string; dot: string; chip: string }
> = {
  grokbot: {
    label: "Grok Bot",
    maker: "X",
    dot: "bg-zinc-900 dark:bg-zinc-100",
    chip: "bg-zinc-900/8 text-zinc-800 dark:bg-zinc-100/10 dark:text-zinc-200",
  },
  muse: {
    label: "Muse",
    maker: "Meta",
    dot: "bg-blue-600",
    chip: "bg-blue-600/10 text-blue-700 dark:text-blue-300",
  },
};

export function ProviderChip({
  provider,
  className,
}: {
  provider: BotProvider;
  className?: string;
}) {
  const p = PROVIDER[provider];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px font-medium text-[10.5px]",
        p.chip,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", p.dot)} />
      {p.label}
    </span>
  );
}

const BOT_STATE: Record<BotState, { label: string; dot: string }> = {
  working: { label: "working", dot: "bg-work animate-pulse" },
  idle: { label: "idle", dot: "bg-[#34c759]" },
  waiting: { label: "waiting", dot: "bg-amber-500" },
  offline: { label: "offline", dot: "bg-zinc-400" },
};

/* A bot's identity: initials on a provider-tinted square, plus its live state. */
export function BotAvatar({ bot, size = 28 }: { bot: Bot; size?: number }) {
  const initials = bot.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="relative inline-grid shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          "grid size-full place-items-center rounded-[8px] font-semibold text-[11px]",
          bot.provider === "muse"
            ? "bg-gradient-to-b from-blue-500 to-indigo-600 text-white"
            : "bg-gradient-to-b from-zinc-700 to-zinc-950 text-white",
        )}
      >
        {initials}
      </span>
      <span
        title={BOT_STATE[bot.state].label}
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
          BOT_STATE[bot.state].dot,
        )}
      />
    </span>
  );
}

export const TICKET_STATE: Record<
  TicketState,
  { label: string; className: string }
> = {
  todo: {
    label: "To do",
    className: "bg-muted-foreground/12 text-muted-foreground",
  },
  working: { label: "Working", className: "bg-work/12 text-work" },
  "needs-ceo": {
    label: "CEO answering",
    className: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  },
  "needs-you": {
    label: "Needs you",
    className: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  },
  review: { label: "CEO checking", className: "bg-teal-500/12 text-tint-text" },
  done: {
    label: "Done",
    className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  },
};

export function TicketStatePill({ state }: { state: TicketState }) {
  const s = TICKET_STATE[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium text-[11px]",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
