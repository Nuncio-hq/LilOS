import { CompactRow, Module } from "../kit";
import type { ResultVM } from "../types";

/* "Results to look at": what finished since you looked. A module, so Home
   shows two rows and Needs three, each with the rest one tap away. */

export function ResultsModule({
  rows,
  max,
  onOpen,
  onMore,
}: {
  rows: ResultVM[];
  /** How many rows the module shows; the rest sit behind "n more". */
  max: number;
  onOpen: (key: string) => void;
  /** Opens the full list. Absent: this screen is the full list. */
  onMore?: () => void;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;
  return (
    <Module
      title="Results to look at"
      footer={
        more > 0 && onMore
          ? { label: `${more} more`, onPress: onMore }
          : undefined
      }
    >
      {shown.map((row) => (
        <CompactRow
          key={row.key}
          testID={`result-${row.key}`}
          dot={row.unseen ? "done" : "idle"}
          title={row.title}
          meta={row.by.name}
          onPress={row.openable ? () => onOpen(row.key) : undefined}
        />
      ))}
    </Module>
  );
}
