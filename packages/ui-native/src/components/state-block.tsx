import type { SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./app-text";
import { Icon, type IconTone } from "./icon";

/* One layout for every "state" screen (camera off, connecting, can't reach,
   expired, connected): icon tile, title, body, optional detail — all anchored
   at the same height so moving between states doesn't make things jump. */
export function StateBlock({
  icon,
  iconTone = "muted-foreground",
  visual,
  title,
  body,
  children,
  testID,
}: {
  icon?: SFSymbol;
  iconTone?: IconTone;
  /** Replaces the icon (e.g. a spinner). */
  visual?: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <View className="gap-6 pt-16" testID={testID}>
      <View className="size-16 items-center justify-center rounded-2xl bg-secondary">
        {visual ?? (icon && <Icon name={icon} size={28} tone={iconTone} />)}
      </View>
      <View className="gap-2">
        <AppText size="title">{title}</AppText>
        {body && <AppText tone="muted">{body}</AppText>}
      </View>
      {children}
    </View>
  );
}

/** A host name / address, shown whole on its own line (never mid-word wrapped). */
export function Mono({ children }: { children: string }) {
  return (
    <AppText
      size="sm"
      className="font-mono"
      numberOfLines={1}
      ellipsizeMode="middle"
    >
      {children}
    </AppText>
  );
}
