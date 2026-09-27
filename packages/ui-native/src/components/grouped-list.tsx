import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "./app-text";
import { Icon } from "./icon";

/* iOS Settings-style grouped list: Section > Row / Choice. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <AppText
        size="xs"
        tone="muted"
        weight="medium"
        className="px-1 uppercase tracking-wider"
      >
        {title}
      </AppText>
      <View className="overflow-hidden rounded-2xl bg-secondary">
        {children}
      </View>
    </View>
  );
}

export function Row({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      className="min-h-[52px] flex-row items-center gap-3 border-b border-border px-4 py-3 active:opacity-60"
    >
      {children}
    </Pressable>
  );
}

export function Choice({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Row onPress={onPress}>
      <AppText className="flex-1">{label}</AppText>
      {on && <Icon name="checkmark" size={16} weight="semibold" />}
    </Row>
  );
}
