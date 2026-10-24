import { View } from "react-native";

/** A thin bar: ink on the rule. `value` is 0 to 1. */
export function ProgressBar({ value }: { value: number }) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      className="h-1.5 overflow-hidden rounded-full bg-rule"
    >
      <View
        className="h-full rounded-full bg-ink"
        style={{ width: `${v * 100}%` }}
      />
    </View>
  );
}
