import type { LanguageModelUsage } from "ai";
import { useEffect, useState } from "react";
import {
  Context,
  ContextContent,
  ContextTrigger,
} from "../components/ai-elements/context";
import {
  contextFull,
  contextShare,
  contextUsedOf,
  contextWindowOf,
} from "../lib/context-window";
import { cn } from "../lib/utils";
import type { ModelOption, Usage } from "../types";

/* Token/context meter for one session (AI Elements Context), laid out like
   Claude Code's context panel: one segmented bar of the whole window — what
   each kind of token takes, then what's free — with a legend of size and
   share. The bar grows in when the card opens. */

const n = (x: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.round(x));
const pct = (x: number, of: number) =>
  `${of ? Math.min(100, (x / of) * 100).toFixed(x > 0 && x / of < 0.1 ? 1 : 0) : 0}%`;

export function SessionUsage({
  usage,
  model,
  models,
}: {
  usage: Usage;
  /** The session's model id — resolved by `sessionModelId` at the call site
      so every surface reads the same model for the same session (#294). */
  model?: string;
  /** Catalog to resolve the display name + a reported context window. */
  models?: ModelOption[];
}) {
  /* The numerator is the engine's CURRENT occupancy when it reports one
     (#415) — `input`/`output` are lifetime sums that outgrow the window. */
  const used = contextUsedOf(usage);
  /* The window is engine-reported (usage, then the catalog row); the
     estimate label `~` marks a window the engine never reported (#294). */
  const { tokens: max, estimated } = contextWindowOf(usage, model, models);
  const full = contextFull(used, max);
  const u: LanguageModelUsage = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: used,
    inputTokenDetails: {
      noCacheTokens: usage.input - usage.cache,
      cacheReadTokens: usage.cache,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: usage.output - usage.reasoning,
      reasoningTokens: usage.reasoning,
    },
  };
  // What fills the window, in the order it was read: cached context first.
  // When the engine reports live occupancy (#415) the wire carries one
  // number — the lifetime counts are session totals, not window parts.
  const parts =
    usage.context !== undefined
      ? [{ label: "In context", value: used, color: "bg-[#007aff]" }]
      : [
          {
            label: "Cached context",
            value: usage.cache,
            color: "bg-[#00a19a]",
          },
          {
            label: "New input",
            value: Math.max(0, usage.input - usage.cache),
            color: "bg-[#007aff]",
          },
          {
            label: "Reasoning",
            value: usage.reasoning,
            color: "bg-[#af52de]",
          },
          {
            label: "Replies",
            value: Math.max(0, usage.output - usage.reasoning),
            color: "bg-[#ff9500]",
          },
        ];
  const free = Math.max(0, max - used);
  const name = models?.find((m) => m.id === model)?.name ?? model;
  const [open, setOpen] = useState(false);
  // Segments start at 0 and grow once the card is on screen.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!open) return setGrown(false);
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <Context usedTokens={used} maxTokens={max} usage={u} onOpenChange={setOpen}>
      {/* #590 AC-3: the bare "3.5%" gets a real name — hover reads
          "Context used: 3.5% of 262k", not an unexplained number. */}
      <ContextTrigger
        size="sm"
        className="h-7 px-1.5 text-xs"
        title={
          full
            ? "Context window full"
            : `Context used: ${pct(used, max)} of ${n(max)}`
        }
        aria-label={
          full
            ? "Context window full"
            : `Context used: ${pct(used, max)} of ${n(max)}`
        }
      />
      <ContextContent className="w-80 divide-y-0 rounded-2xl p-0">
        <div className="space-y-3 p-4" data-context-panel>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold text-[13px]">Context window</span>
            <span
              className="font-medium text-[12px] text-muted-foreground tabular-nums"
              title={
                estimated
                  ? "Estimated — the engine reports no window"
                  : undefined
              }
            >
              {n(used)} / {estimated ? `~${n(max)}` : n(max)}
              <span className="ml-1.5 text-foreground">
                {full ? "Full" : pct(used, max)}
              </span>
            </span>
          </div>
          <div className="flex h-2 gap-px overflow-hidden rounded-full bg-foreground/10">
            {parts.map((p, i) => (
              <span
                key={p.label}
                className={cn(
                  "h-full transition-[width] duration-700 ease-[cubic-bezier(0.2,0.9,0.25,1)]",
                  p.color,
                )}
                style={{
                  width: grown ? `${contextShare(p.value, max) * 100}%` : "0%",
                  transitionDelay: `${i * 70}ms`,
                }}
              />
            ))}
          </div>
          <ul className="space-y-1.5">
            {parts.map((p) => (
              <li
                key={p.label}
                className="grid grid-cols-[10px_1fr_auto_3.2rem] items-center gap-2.5 text-[13px]"
              >
                <span className={cn("size-2.5 rounded-[3px]", p.color)} />
                <span>{p.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {n(p.value)}
                </span>
                <span className="text-right tabular-nums">
                  {pct(p.value, max)}
                </span>
              </li>
            ))}
            <li className="grid grid-cols-[10px_1fr_auto_3.2rem] items-center gap-2.5 text-[13px] text-muted-foreground">
              <span className="size-2.5 rounded-[3px] bg-foreground/10" />
              <span>Free space</span>
              <span className="tabular-nums">{n(free)}</span>
              <span className="text-right tabular-nums">{pct(free, max)}</span>
            </li>
          </ul>
          {usage.context !== undefined && (
            /* Lifetime throughput, labeled as what it is — these sums count
               every tool-loop call, not what sits in the window (#415). */
            <p className="text-[12px] text-muted-foreground">
              This thread — {n(usage.input)} in ·{" "}
              {n(usage.output + usage.reasoning)} out
              {usage.cache ? ` · ${n(usage.cache)} cached` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 bg-muted/50 px-4 py-2.5 text-[12px]">
          <span className="text-muted-foreground">Model</span>
          <span className="truncate font-medium">{name ?? "—"}</span>
        </div>
      </ContextContent>
    </Context>
  );
}
