import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { Status } from "../types";
import { StatusDot, T } from "./base";

/* One line inside a module: a status dot, a title, a short meta, something at
   the end (an initial, a time). It never wraps; a long title is cut. */

export function CompactRow({
  dot,
  title,
  meta,
  trailing,
  onPress,
  testID,
}: {
  dot?: Status;
  title: string;
  meta?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <View className="min-h-10 flex-row items-center gap-2.5">
      {dot ? <StatusDot status={dot} size={8} /> : null}
      <T
        variant="small"
        numberOfLines={1}
        className="flex-1 shrink font-medium"
      >
        {title}
      </T>
      {meta ? (
        <T variant="caption" tone="ink3" numberOfLines={1} className="shrink-0">
          {meta}
        </T>
      ) : null}
      {typeof trailing === "string" ? (
        <T variant="caption" tone="ink2" className="font-semibold">
          {trailing}
        </T>
      ) : (
        trailing
      )}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={meta ? `${title}, ${meta}` : title}
      onPress={onPress}
      className="active:opacity-60"
    >
      {body}
    </Pressable>
  );
}
