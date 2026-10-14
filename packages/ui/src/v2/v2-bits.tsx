import { cn } from "../lib/utils";
import type { V2State } from "./v2-types";

/* The one state mark: a 8px dot that says what a thread needs. Colour is
   reserved for state; everything else on a row stays neutral. Working is a
   ring that breathes, so a column of running threads reads as motion, not
   as a wall of blue. */
export function StateDot({
  state,
  className,
}: {
  state: V2State;
  className?: string;
}) {
  const base = "inline-block size-2 shrink-0 rounded-full";
  if (state === "working")
    return (
      <span
        role="img"
        aria-label="Working"
        className={cn(
          base,
          "lilos-v2-breathe border-[1.5px] border-work",
          className,
        )}
      />
    );
  const tone: Record<Exclude<V2State, "working">, string> = {
    needs: "bg-amber-500",
    failed: "bg-red-500",
    unseen: "bg-primary",
    idle: "bg-transparent",
    snoozed: "bg-violet-400/70",
    settled: "bg-transparent",
  };
  const label: Record<Exclude<V2State, "working">, string> = {
    needs: "Needs you",
    failed: "Failed",
    unseen: "New result",
    idle: "",
    snoozed: "Snoozed",
    settled: "Settled",
  };
  return label[state] ? (
    <span
      role="img"
      aria-label={label[state]}
      className={cn(base, tone[state], className)}
    />
  ) : (
    <span aria-hidden className={cn(base, tone[state], className)} />
  );
}

export const STATE_WORD: Record<V2State, string> = {
  needs: "Needs you",
  failed: "Failed",
  unseen: "New result",
  working: "Working",
  idle: "Idle",
  snoozed: "Snoozed",
  settled: "Settled",
};

export const ago = (m: number) =>
  m < 1
    ? "now"
    : m < 60
      ? `${m}m`
      : m < 1440
        ? `${Math.round(m / 60)}h`
        : `${Math.round(m / 1440)}d`;
