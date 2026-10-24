import { useState } from "react";
import { Pressable, View } from "react-native";
import { T } from "./base";

/* A body that stops after a few lines and says so. "more" shows only when the
   text really is longer than `lines` (measured on a hidden copy), so a short
   text carries no dead control. */

export function ClampText({
  lines,
  children,
  onMore,
  tone = "ink",
  variant = "small",
}: {
  lines: number;
  children: string;
  /** Opens the whole text (a sheet or the screen it belongs to). */
  onMore?: () => void;
  tone?: "ink" | "ink2" | "ink3";
  variant?: "body" | "small" | "caption";
}) {
  const [cut, setCut] = useState(false);
  return (
    <View>
      <T variant={variant} tone={tone} numberOfLines={lines}>
        {children}
      </T>
      {onMore ? (
        <T
          variant={variant}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          className="absolute inset-x-0 top-0 opacity-0"
          onTextLayout={(e) => setCut(e.nativeEvent.lines.length > lines)}
        >
          {children}
        </T>
      ) : null}
      {onMore && cut ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="more"
          onPress={onMore}
          hitSlop={8}
          className="self-start pt-0.5 active:opacity-60"
        >
          <T variant={variant} tone="ink2" className="font-semibold">
            more
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}
