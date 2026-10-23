import type { Status } from "./types";

/* Status words and colours. Full class names (never built from strings) so
   Tailwind sees them. A dot is the fill, an ink is readable text. */

export const STATUS_WORD: Record<Status, string> = {
  working: "Working",
  waiting: "Waiting",
  needs: "Needs you",
  stuck: "Stuck",
  idle: "Idle",
  done: "Done",
  planned: "Planned",
  failed: "Failed",
};

export const DOT: Record<Status, string> = {
  working: "bg-st-working",
  waiting: "bg-st-waiting",
  needs: "bg-st-needs",
  stuck: "bg-st-stuck",
  idle: "bg-st-idle",
  done: "bg-st-done",
  planned: "border border-st-idle bg-transparent",
  failed: "bg-st-stuck",
};

export const INK: Record<Status, string> = {
  working: "text-st-working-ink",
  waiting: "text-st-waiting-ink",
  needs: "text-st-needs-ink",
  stuck: "text-st-stuck-ink",
  idle: "text-st-idle-ink",
  done: "text-st-done-ink",
  planned: "text-st-idle-ink",
  failed: "text-st-stuck-ink",
};

/** Theme variable name for a status colour (for icons). */
export const STATUS_VAR: Record<Status, string> = {
  working: "st-working",
  waiting: "st-waiting",
  needs: "st-needs",
  stuck: "st-stuck",
  idle: "st-idle",
  done: "st-done",
  planned: "st-idle",
  failed: "st-stuck",
};
