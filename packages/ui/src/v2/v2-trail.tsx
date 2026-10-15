import {
  ArrowRightLeftIcon,
  BadgeCheckIcon,
  BotIcon,
  ExternalLinkIcon,
  FileOutputIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { V2TrailKind, V2TrailLine } from "./v2-work-types";

const ICON: Record<V2TrailKind, typeof TerminalIcon> = {
  handoff: ArrowRightLeftIcon,
  note: MessageSquareTextIcon,
  command: TerminalIcon,
  helper: BotIcon,
  output: FileOutputIcon,
  ask: MessageCircleQuestionIcon,
  check: BadgeCheckIcon,
};

/* Colour only where it carries meaning: an ask is amber, the CEO's check is
   green, a running line breathes in the work colour. */
const TONE: Partial<Record<V2TrailKind, string>> = {
  ask: "text-amber-500",
  check: "text-emerald-500",
};

/* A ticket's live trail: what its worker is doing, line by line, the same
   way for a LilOS agent and for an outside bot behind a connector. Each line
   is icon · who · what, with where it ran and a short fact on the right. */
export function V2Trail({ lines }: { lines: V2TrailLine[] }) {
  return (
    <ol className="relative flex flex-col">
      {lines.map((l, i) => {
        const Icon = ICON[l.kind];
        const last = i === lines.length - 1;
        return (
          <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className="absolute top-6 bottom-0 left-[11px] w-px bg-foreground/[0.08]"
              />
            )}
            <span
              className={cn(
                "relative grid size-6 shrink-0 place-items-center rounded-full bg-foreground/[0.05] [&_svg]:size-3.5",
                l.live
                  ? "text-work ring-1 ring-[var(--work)]/40"
                  : (TONE[l.kind] ?? "text-muted-foreground"),
              )}
            >
              <Icon />
              {l.live && (
                <span
                  aria-hidden
                  className="lilos-v2-breathe absolute -inset-[3px] rounded-full border-[1.5px] border-work"
                />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className="shrink-0 font-medium">{l.who}</span>
                {l.where && (
                  <span className="shrink-0 rounded-full bg-foreground/[0.05] px-1.5 text-[11px] text-muted-foreground">
                    {l.where}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {l.time}
                </span>
              </div>
              <p
                className={cn(
                  "mt-0.5 text-[13px] leading-snug",
                  l.kind === "command"
                    ? "truncate font-mono text-[12px] text-foreground/85"
                    : "text-foreground/90",
                )}
              >
                {l.text}
              </p>
              {(l.meta || l.link) && (
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  {l.meta && <span>{l.meta}</span>}
                  {l.link && (
                    <a
                      href={l.link}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      <ExternalLinkIcon className="size-3" />
                      Open
                    </a>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
