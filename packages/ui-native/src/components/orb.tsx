import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useThemeColor } from "./icon";

/* An employee's identity: a soft, matte color orb (no initials, no photo),
   the mobile twin of the web avatar colour. The ring carries state:
   blue arc = working, teal ring + "!" = waiting on you, none = idle. */

export type OrbTone = "blue" | "violet" | "sunset" | "stone" | "mint" | "rose";
export type OrbState = "idle" | "working" | "needs-you";

/* Soft radial blobs over a base, like a lava-lamp photo shot out of
   focus, under a glassy highlight. Hex because React Native gradients don't read CSS variables. */
const TONES: Record<OrbTone, { base: string; a: string; b: string }> = {
  blue: { base: "#3f7ff5", a: "#4fe3d2", b: "#7b6cff" },
  violet: { base: "#9a5cf0", a: "#ff6fa8", b: "#ffb14a" },
  sunset: { base: "#f47a3a", a: "#ffd84d", b: "#ff5a5f" },
  stone: { base: "#a79f92", a: "#cfc6b4", b: "#8c8478" },
  mint: { base: "#2fae8e", a: "#b6f09a", b: "#1f7fa8" },
  rose: { base: "#e8577a", a: "#ffc0a8", b: "#b04ad0" },
};

export function Orb({
  tone,
  size = 44,
  state = "idle",
  badge = true,
}: {
  tone: OrbTone;
  size?: number;
  state?: OrbState;
  /** Show the small "!" on needs-you (off where the row already says it). */
  badge?: boolean;
}) {
  const t = TONES[tone];
  const work = useThemeColor("work");
  const paper = useThemeColor("background");
  const ring = size >= 30 ? 2.5 : 2;
  const gap = size >= 30 ? 3 : 2;
  const outer = size + (ring + gap) * 2;
  return (
    <View
      style={{ width: outer, height: outer }}
      className="items-center justify-center"
    >
      {state === "working" && <Spinner color={work} ring={ring} />}
      {state === "needs-you" && (
        <View
          className="absolute inset-0 rounded-full border-primary"
          style={{ borderWidth: ring }}
        />
      )}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.base,
          overflow: "hidden",
          opacity: state === "idle" && tone === "stone" ? 0.9 : 1,
          // A thin light rim + a soft highlight up top read as glass.
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.32)",
          experimental_backgroundImage: [
            {
              type: "radial-gradient",
              shape: "circle",
              size: "farthest-side",
              position: { top: "8%", left: "30%" },
              colorStops: [
                { color: "rgba(255,255,255,0.42)" },
                { color: "rgba(255,255,255,0)", positions: ["55%"] },
              ],
            },
            {
              type: "radial-gradient",
              shape: "circle",
              size: "closest-side",
              position: { top: "78%", left: "72%" },
              colorStops: [{ color: t.a }, { color: `${t.a}00` }],
            },
            {
              type: "radial-gradient",
              shape: "circle",
              size: "farthest-side",
              position: { top: "72%", left: "25%" },
              colorStops: [
                { color: t.b },
                { color: `${t.b}00`, positions: ["70%"] },
              ],
            },
          ],
        }}
      />
      {state === "needs-you" && badge && (
        <View
          className="absolute items-center justify-center rounded-full bg-primary"
          style={{
            right: -2,
            top: -2,
            width: size >= 30 ? 18 : 14,
            height: size >= 30 ? 18 : 14,
            borderWidth: 2.5,
            borderColor: paper,
          }}
        >
          <View className="h-[7px] w-[2px] rounded-full bg-primary-foreground" />
          <View className="mt-[1.5px] size-[2px] rounded-full bg-primary-foreground" />
        </View>
      )}
    </View>
  );
}

/* Working: a half ring that keeps turning around the orb, one lap every
   1.1 s, eased so it reads as effort rather than a loading spinner. */
function Spinner({ color, ring }: { color?: string; ring: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 1100,
        easing: Easing.bezier(0.45, 0.1, 0.55, 0.9),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  const rotate = v.interpolate({
    inputRange: [0, 1],
    outputRange: ["-20deg", "340deg"],
  });
  return (
    <Animated.View
      className="absolute inset-0 rounded-full"
      style={{
        borderWidth: ring,
        borderColor: "transparent",
        borderTopColor: color,
        borderRightColor: color,
        transform: [{ rotate }],
      }}
    />
  );
}
