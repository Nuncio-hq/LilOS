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
  /** Opens what the number counts. Absent: the tile only says the number
      (something else on the screen already shows what it counts). */
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <>
      <Text
        className={`text-[30px] font-semibold leading-[34px] ${value > 0 ? INK[tone] : "text-ink-3"}`}
      >
        {String(value)}
      </Text>
      <T variant="caption" tone="ink2" numberOfLines={1}>
        {label}
      </T>
    </>
  );
  const box =
    "min-h-[62px] flex-1 justify-center rounded-[22px] bg-paper-soft px-4 py-2";
  if (!onPress)
    return (
      <View
        testID={testID}
        accessible
        accessibilityLabel={`${value} ${label.toLowerCase()}`}
        className={box}
        style={{ borderCurve: "continuous" }}
      >
        {body}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label.toLowerCase()}`}
      onPress={onPress}
      className={`${box} active:opacity-60`}
      style={{ borderCurve: "continuous" }}
    >
      {body}
    </Pressable>
  );
}

export function StatTiles({ children }: { children: ReactNode }) {
  return <View className="flex-row gap-2.5">{children}</View>;
}
