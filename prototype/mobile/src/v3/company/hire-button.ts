import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { openHire } from "../nav";

/** The `+` at the right of the navigation bar that opens Hire: a native bar
    button (Liquid Glass on iOS 26). Company and People both wear it. */
export const HIRE_BUTTON: Pick<
  NativeStackNavigationOptions,
  "unstable_headerRightItems"
> = {
  unstable_headerRightItems: () => [
    {
      type: "button",
      label: "Hire",
      icon: { type: "sfSymbol", name: "plus" },
      accessibilityLabel: "Hire",
      onPress: openHire,
    },
  ],
};
