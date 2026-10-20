import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import type { V3PageProps, V3Thread, V3Workbench } from "./v3-types";

export type WbTab =
  | "changes"
  | "files"
  | "terminal"
  | "preview"
  | "pr"
  | "background";

/** Everything a session's work panel can show: the Workbench tabs plus the
   session's own browser and the thread's details. */
export type SessionTab = WbTab | "browser" | "details";

/** What every Workbench tab gets. `onTab` jumps to another tab of the
   session (the browser included); `onAsk` focuses the chat's composer. */
export type WbPanelProps = V3PageProps & {
  thread: V3Thread;
  wb: V3Workbench;
  onTab: (tab: SessionTab) => void;
  onAsk: () => void;
};

/* Small pieces the Workbench tabs share: the panel with its sticky bottom
   bar, a card, a field, a button that can be switched off, a quiet line and
   the tinted diff lines. */

/** A tab's body, and optionally a bar that sticks to the bottom of the work
   panel like the composer does under the chat. Both are direct children of
   the panel's scroller (a fragment), which is what lets the bar stick. */
export function Panel({
  children,
  bar,
}: {
  children: ReactNode;
  bar?: ReactNode;
}) {
  return (
    <>
      <div className="flex-1 px-5 pt-5 pb-8">{children}</div>
      {bar && (
        <div className="sticky bottom-0 border-[var(--v3-line)] border-t bg-[var(--v3-main)] px-5 pt-3 pb-4">
          {bar}
        </div>
      )}
    </>
  );
}

export const CARD = "rounded-[10px] border border-[var(--v3-line)]";

export const FIELD =
  "h-7 min-w-0 rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30";

/** Same look as `Btn`, plus a disabled state (Btn has none). */
export function WbBtn({
  children,
  onClick,
  primary,
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 font-medium text-[13px] transition-[background,transform] enabled:active:scale-[0.97] disabled:cursor-default disabled:opacity-55",
        primary
          ? "border-foreground bg-foreground text-background enabled:hover:bg-foreground/85"
          : "border-foreground/15 bg-background text-foreground enabled:hover:bg-[var(--v3-hover)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] text-muted-foreground/70">{children}</p>;
}

/** The +/− lines of one diff. `min-w-max` keeps every tinted row as wide as
   the longest line when the card scrolls sideways. */
export function DiffLines({
  lines,
}: {
  lines: V3Workbench["diffs"][number]["lines"];
}) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-max py-1.5 font-mono text-[12px] leading-[1.65]">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "flex gap-2 px-3.5",
              l.kind === "add" && "bg-emerald-50/70 dark:bg-emerald-400/10",
              l.kind === "del" && "bg-red-50/70 dark:bg-red-400/10",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "w-2.5 shrink-0 select-none text-center",
                l.kind === "add" && "text-emerald-700 dark:text-emerald-400",
                l.kind === "del" && "text-red-600 dark:text-red-400",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
            </span>
            <span className="whitespace-pre text-foreground/90">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Added and removed lines across every changed file. */
export function diffTotals(wb: V3Workbench) {
  return wb.diffs.reduce(
    (t, d) => ({ add: t.add + d.add, del: t.del + d.del }),
    { add: 0, del: 0 },
  );
}
