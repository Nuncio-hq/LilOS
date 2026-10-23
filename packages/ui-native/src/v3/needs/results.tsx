import { View } from "react-native";
import { Avatar, SectionBlock, T } from "../kit";
import { ListRow } from "../rows";
import type { Person } from "../types";

/** One finished thing to look at, ready to draw. */
export type ResultVM = {
  key: string;
  title: string;
  by: Person;
  note: string;
  /** Where it lives: ticket id, project or "Chat". */
  tag: string;
  /** "41 min ago" */
  ago: string;
  /** Finished past your read mark. */
  unseen: boolean;
  /** It has a thread or a ticket to open; without either the row is plain. */
  openable: boolean;
};

export function ResultsToLookAt({
  rows,
  onOpen,
}: {
  rows: ResultVM[];
  onOpen: (key: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <SectionBlock title="Results to look at">
      {rows.map((row, i) => (
        <ListRow
          key={row.key}
          testID={`result-${row.key}`}
          label={`${row.title}, ${row.by.name}${row.unseen ? ", new" : ""}`}
          onPress={row.openable ? () => onOpen(row.key) : undefined}
          last={i === rows.length - 1}
        >
          <View className="flex-row items-start gap-3">
            <Avatar person={row.by} size={34} />
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-center justify-between gap-2">
                <T variant="label" numberOfLines={1} className="flex-1">
                  {row.title}
                </T>
                {row.unseen ? (
                  <View className="size-2 rounded-full bg-st-done" />
                ) : null}
              </View>
              <T variant="caption" numberOfLines={1}>
                {`${row.by.name} · ${row.tag} · ${row.ago}`}
              </T>
              {row.note ? (
                <T variant="caption" tone="ink3" numberOfLines={2}>
                  {row.note}
                </T>
              ) : null}
            </View>
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}
