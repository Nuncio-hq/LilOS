import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";

const LIQUID = isLiquidGlassAvailable();

/* iOS 26 Liquid Glass for the few custom surfaces that float above content
   (composer, round header buttons). System chrome — tab bar, nav bar, bar
   buttons — gets glass from UIKit and never uses this. Before iOS 26 it
   falls back to a translucent card so layouts stay identical. */
export function Glass({
  children,
  className,
  style,
  interactive = false,
}: {
  children?: ReactNode;
  /** Padding/layout only: the shape (radius) goes in `style`. */
  className?: string;
  style?: StyleProp<ViewStyle>;
  /** Buttons: the glass reacts to touch (press shimmer + scale). */
  interactive?: boolean;
}) {
  if (!LIQUID)
    return (
      <View
        className={`overflow-hidden border border-border bg-glass ${className ?? ""}`}
        style={style}
      >
        {children}
      </View>
    );
  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive={interactive}
      style={[{ overflow: "hidden" }, style]}
    >
      <View className={className}>{children}</View>
    </GlassView>
  );
}
