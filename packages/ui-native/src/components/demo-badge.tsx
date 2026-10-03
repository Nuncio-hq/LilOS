import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "./app-text";

/* A small "Demo" pill floating over every screen while the app runs on the
   offline demo world (#168 AC-4) — always visible, never interactive, and
   out of the content's way. Mounted two ways: the root overlay (default
   "top") floats it in the top safe-area band above every screen and every
   native header; iOS form sheets sit in a presented window above that
   overlay, so sheet screens mount the "sheet" variant inside their own
   screenLayout, tucked at the sheet's top edge beside the grabber. */
export function DemoBadge({ variant = "top" }: { variant?: "top" | "sheet" }) {
  const insets = useSafeAreaInsets();
  const top =
    variant === "sheet" ? insets.top + 2 : Math.max(insets.top - 22, 6);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      className="absolute right-4 top-0"
      style={{ marginTop: top }}
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
