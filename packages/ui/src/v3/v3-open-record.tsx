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

/** The record open in the side peek, raw (for ancestor-aware marking: an
   open helper marks its nearest listed ancestor's row, D-#847). */
export function useOpenRoute() {
  return useContext(OpenRecord);
}

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
  marked,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  opens?: V3RecordRoute;
  /** Marks the row for a record that is not `opens` itself — an open helper
     thread marks its nearest listed ancestor's row (D-#847). */
  marked?: boolean;
}) {
  const open = useContext(OpenRecord);
  const selected =
    (!!opens && open?.page === opens.page && open.id === opens.id) ||
    marked === true;
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
