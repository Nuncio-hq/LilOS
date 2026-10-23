import { Pressable, ScrollView, View } from "react-native";
import { Icon } from "../../components/icon";
import { T } from "../kit";
import { ListRow } from "../rows";
import type { HireSheetProps } from "./types";

/** The Hire sheet (a native form sheet, so it draws its own header): one
    card per kind of agent; tapping a card hires one. */
export function HireSheet({ cards, onHire, onClose }: HireSheetProps) {
  return (
    // One scroll view is the sheet's whole content: a native form sheet
    // lays out a lone ScrollView (the header scrolls with the cards).
    <ScrollView
      className="flex-1 bg-paper"
      testID="hire-sheet"
      contentContainerStyle={{ paddingBottom: 48 }}
    >
      <View className="flex-row items-center justify-between px-5 pt-5 pb-1">
        <T variant="title">Hire</T>
        <Pressable
          testID="hire-close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          hitSlop={10}
          className="size-11 items-center justify-center rounded-full bg-paper-soft active:opacity-60"
        >
          <Icon
            name="xmark"
            size={15}
            weight="semibold"
            tone="muted-foreground"
          />
        </Pressable>
      </View>
      {cards.map((c, i) => (
        <ListRow
          key={c.role}
          testID={`hire-${c.role}`}
          label={`Hire ${c.role}`}
          onPress={() => onHire(c.role)}
          last={i === cards.length - 1}
        >
          <View className="flex-row items-center gap-3">
            <View className="flex-1 gap-0.5">
              <T variant="label">{c.role}</T>
              <T variant="small" tone="ink2">
                {c.does}
              </T>
              {c.model ? (
                <T variant="caption" tone="ink3">
                  {`Runs on ${c.model}`}
                </T>
              ) : null}
            </View>
            <Icon
              name="plus"
              size={16}
              weight="semibold"
              tone="muted-foreground"
            />
          </View>
        </ListRow>
      ))}
    </ScrollView>
  );
}
