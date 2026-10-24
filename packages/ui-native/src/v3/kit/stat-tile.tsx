import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { T } from "./base";

/* Three glanceable numbers in a row: how many are working, need you, are
   stuck. The number wears its status colour only when there is something to
   look at; a zero goes quiet. */

type Tone = "work" | "needs" | "stuck" | "idle";

const INK: Record<Tone, string> = {
  work: "text-st-working-ink",
  needs: "text-st-needs-ink",
  stuck: "text-st-stuck-ink",
  idle: "text-st-idle-ink",
};

export function StatTile({
  value,
  label,
  tone,
  onPress,
  testID,
}: {
  value: number;
  label: string;
  tone: Tone;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label.toLowerCase()}`}
      onPress={onPress}
      className="min-h-[76px] flex-1 justify-center rounded-[22px] bg-paper-soft px-4 py-3 active:opacity-60"
      style={{ borderCurve: "continuous" }}
    >
      <Text
        className={`text-[32px] font-semibold leading-[36px] ${value > 0 ? INK[tone] : "text-ink-3"}`}
      >
        {String(value)}
      </Text>
      <T variant="caption" tone="ink2" numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

export function StatTiles({ children }: { children: ReactNode }) {
  return <View className="flex-row gap-2.5 px-4 pt-1">{children}</View>;
}
