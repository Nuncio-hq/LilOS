import { View } from "react-native";
import { AppText } from "./app-text";

/* The company's mark, like the desktop sidebar header: a teal squircle with
   its initials. Sits in the nav bar beside the bar buttons on Home. */

/** "Oscar Co" → "OC". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "·";

export function CompanyChip({
  name,
  size = 34,
}: {
  name: string;
  size?: number;
}) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={name}
      className="items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        borderCurve: "continuous",
        experimental_backgroundImage: [
          {
            type: "linear-gradient",
            direction: "to bottom",
            colorStops: [{ color: "#14b8a6" }, { color: "#0f766e" }],
          },
        ],
      }}
    >
      <AppText weight="semibold" tone="none" className="text-[13px] text-white">
        {initials(name)}
      </AppText>
    </View>
  );
}
