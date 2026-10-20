import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import { DOT } from "./v3-marks";
import type { V3Status } from "./v3-types";

/* A one-line notice above the page for what the app itself cannot work
   without (the relay unreachable, the engine down). Quiet and calm like the
   rest of v3: a status dot, one sentence, an optional action. It is drawn
   only while something is wrong, so a healthy company shows nothing. */
export function V3Banner({
  status,
  text,
  action,
}: {
  /** The status word whose dot leads the line. */
  status: V3Status;
  text: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-[var(--v3-line)] border-b bg-[var(--v3-soft)] px-5 py-1.5 text-[13px] text-muted-foreground"
    >
      <i className={cn("size-[7px] shrink-0 rounded-full", DOT[status])} />
      <span className="min-w-0 flex-1 truncate">
        {/* The engine's reason carries commands in backticks (#99). */}
        <InlineCodeText text={text} />
      </span>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-foreground hover:bg-[var(--v3-hover)]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
