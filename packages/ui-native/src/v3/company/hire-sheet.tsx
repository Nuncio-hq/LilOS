import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { T } from "../kit";
import type { HireCardVM, HireSheetProps } from "./types";

const SERIF = { fontFamily: "Charter" } as const;

/** One kind of agent: what it does, what it runs on. The whole card hires. */
function HireCard({
  card,
  onHire,
}: {
  card: HireCardVM;
  onHire: (role: string) => void;
}) {
  return (
    <Pressable
      testID={`hire-${card.role}`}
      accessibilityRole="button"
      accessibilityLabel={`Hire ${card.role}`}
      onPress={() => onHire(card.role)}
      className="flex-row items-center gap-3 rounded-[22px] bg-paper-soft p-4 active:opacity-60"
      style={{ borderCurve: "continuous" }}
    >
      <View className="flex-1 gap-1">
        <Text
          className="font-semibold text-[18px] text-ink leading-[24px]"
          style={SERIF}
          numberOfLines={1}
        >
          {card.role}
        </Text>
        <T variant="small" tone="ink2" numberOfLines={2}>
          {card.does}
        </T>
        {card.model ? (
          <T variant="caption" tone="ink3" numberOfLines={1}>
            {`Runs on ${card.model}`}
          </T>
        ) : null}
      </View>
      <View className="h-8 items-center justify-center rounded-full bg-ink px-3.5">
        <Text className="font-semibold text-[14px] text-paper">Hire</Text>
      </View>
    </Pressable>
  );
}

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
      <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
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
      <View className="gap-3 px-4">
        {cards.map((c) => (
          <HireCard key={c.role} card={c} onHire={onHire} />
        ))}
      </View>
    </ScrollView>
  );
}
