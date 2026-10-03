import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Group, SheetHeader } from "./folder-picker";

/* The phone's Workbench → Changes (#340 AC-2b): the diffs a `workbench_open`
   card opens. The relay keeps no fs, so the rows are the session's own
   recorded edits (turn-step patches) — the same diff lines a step opens to. */

export type WbDiffFile = { path: string; patch: string };

export function WbDiffSheet({
  files,
  focus,
  onDone,
}: {
  files: WbDiffFile[];
  /** The path the card named — rows for it lead, the rest follow. */
  focus?: string;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const named = focus ? files.filter((f) => f.path === focus) : [];
  const rows = named.length ? named : files;
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader title="Changes" onDone={onDone} />
      </View>
      {!rows.length && (
        <AppText tone="muted" className="text-center">
          {focus
            ? `No recorded edits to ${focus} yet.`
            : "No recorded edits in this session yet."}
        </AppText>
      )}
      {!!rows.length && (
        <Group
          title={
            focus && named.length ? focus : `${rows.length} file change(s)`
          }
        >
          {rows.map((f, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
              key={`${f.path}-${i}`}
              className="gap-0.5 px-3 py-2.5"
            >
              <AppText
                tone="muted"
                className="font-mono text-[11.5px]"
                numberOfLines={1}
              >
                {f.path}
              </AppText>
              <View className="overflow-hidden rounded-lg bg-background">
                {f.patch.split("\n").map((line, j) => {
                  const tone = line.startsWith("@@")
                    ? "bg-work-soft text-work"
                    : line.startsWith("+")
                      ? "bg-success/12 text-success"
                      : line.startsWith("-")
                        ? "bg-destructive/10 text-destructive"
                        : "text-subtle-foreground";
                  return (
                    <Text
                      // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                      key={j}
                      numberOfLines={1}
                      className={`px-2.5 font-mono text-[11px] leading-[17px] ${tone}`}
                    >
                      {line || " "}
                    </Text>
                  );
                })}
              </View>
            </View>
          ))}
        </Group>
      )}
    </ScrollView>
  );
}
