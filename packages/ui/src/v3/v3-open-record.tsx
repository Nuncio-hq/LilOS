import { createContext, type ReactNode, useContext } from "react";
import { cn } from "../lib/utils";
import type { V3RecordRoute } from "./v3-page-types";

/* Which record is open in the side peek, and the rows that mark themselves
   when it is theirs, so the list you came from always shows where you are. */

/** The record open in the side peek. Lists mark its row, so the list you
   came from always shows which item you are looking at. */
export const OpenRecord = createContext<V3RecordRoute | undefined>(undefined);

/** Whether `page:id` is the record open in the side peek. */
export function useOpenRecord() {
  const open = useContext(OpenRecord);
  return (page: V3RecordRoute["page"], id: string) =>
    open?.page === page && open.id === id;
}

/** The side peek's width, for the record inside it. A thread widens it into
   a session (chat on the left, its work on the right) and narrows it back
   beside the list; null when the record is not in a peek. */
export const PeekWidth = createContext<{
  full: boolean;
  setFull: (full: boolean) => void;
} | null>(null);

/** The mark for an open row: a quiet tint and an ink bar on its left edge. */
export const OPEN_ROW =
  "bg-[var(--v3-hover)] shadow-[inset_2px_0_0_var(--foreground)]";

/** A row that opens something: hover tint, no box. Given the record it
   opens, it marks itself while that record is in the side peek. */
export function RowButton({
  onClick,
  children,
  className,
  opens,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  opens?: V3RecordRoute;
}) {
  const open = useContext(OpenRecord);
  const selected = !!opens && open?.page === opens.page && open.id === opens.id;
  return (
    // A row holds buttons of its own, so it cannot be a <button>.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onClick();
      }}
      className={cn(
        "-mx-2 cursor-pointer rounded-md px-2 outline-none transition-colors hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]",
        className,
        selected && OPEN_ROW,
      )}
    >
      {children}
    </div>
  );
}
