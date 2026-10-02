import { View } from "react-native";
import { AppText } from "./app-text";

/* A small "Demo" pill floating over every screen while the app runs on the
   offline demo world (#168 AC-4) — always visible, never interactive, and
   out of the content's way (bottom center, above the fold). */
export function DemoBadge() {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      className="absolute inset-x-0 bottom-8 items-center"
    >
      <View className="rounded-full border border-warning/50 bg-warning/15 px-3.5 py-1.5">
        <AppText
          size="xs"
          weight="semibold"
          tone="warning"
          className="uppercase tracking-wider"
        >
          Demo
        </AppText>
      </View>
    </View>
  );
}
