import { cn } from "../lib/utils";
import type { V3ConnectRow } from "./v3-types";

/* The engine's profiles and whether LilOS is connected to each: the approval
   that lets an engine's agents see the app. Shown in Settings → Engine and in
   first run; the engine's name comes from the data, never from here. */

const STATE: Record<
  V3ConnectRow["state"],
  { word: string; dot: string; text: string }
> = {
  connected: {
    word: "Connected",
    dot: "bg-emerald-500",
    text: "text-muted-foreground",
  },
  "not-connected": {
    word: "Not connected",
    dot: "bg-stone-400",
    text: "text-muted-foreground",
  },
  updating: {
    word: "Updating…",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  failed: {
    word: "Failed",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-300",
  },
};

export function ConnectRows({ rows }: { rows: V3ConnectRow[] }) {
  if (rows.length === 0)
    return (
      <p className="border-[var(--v3-line)] border-b py-3 text-[14px] text-muted-foreground">
        No agents hired yet. New hires ask to connect when they are hired.
      </p>
    );
  return (
    <>
      {rows.map((r) => {
        const s = STATE[r.state];
        return (
          <div
            key={r.profile}
            className="flex items-center gap-3 border-[var(--v3-line)] border-b py-2.5"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] text-foreground">
                {r.employee ?? r.profile}
              </span>
              <span className="block truncate font-mono text-[12.5px] text-muted-foreground">
                {r.profile}
              </span>
              {r.state === "failed" && r.reason && (
                <span className="block text-[13px] text-red-600 dark:text-red-300">
                  {r.reason}
                </span>
              )}
            </span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 text-[13px]",
                s.text,
              )}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", s.dot)}
              />
              {s.word}
            </span>
          </div>
        );
      })}
    </>
  );
}
