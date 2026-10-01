import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useThemeColor } from "../components/icon";
import type { SessionLife } from "./types";

/* #344: whether a thread's engine session holds the Mac, without words (web:
   the `.lilos-life` ring on the "N replies" pill). A thin capsule ring in the
   working colours (violet → blue → teal) around the replies count: still
   while the session is open and idle, a bright stretch of it travelling round
   while it runs (a turn or any subagent), nothing once it's closed. Reduced
   motion: running is the full-strength ring, still. */

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const STROKE = 1.5;

export function LifePill({
  life,
  children,
}: {
  life?: SessionLife;
  children: ReactNode;
}) {
  const work = useThemeColor("work") ?? "#007aff";
  const [box, setBox] = useState({ w: 0, h: 0 });
  const still = useReducedMotion();
  const run = life === "running" && !still;
  const shown = life === "open" || life === "running";
  const w = box.w - STROKE;
  const h = box.h - STROKE;
  const perimeter = w > 0 ? 2 * (w - h) + Math.PI * h : 0;
  const arc = perimeter * 0.3;
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) return;
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 2400,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [run, v]);
  const offset = v.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -perimeter || -1],
  });
  return (
    <View
      onLayout={(e) =>
        setBox({
          w: e.nativeEvent.layout.width,
          h: e.nativeEvent.layout.height,
        })
      }
      className="flex-row items-center gap-1 rounded-full px-2 py-0.5"
    >
      {shown && w > 0 && (
        <Svg
          width={box.w}
          height={box.h}
          style={{ position: "absolute", left: 0, top: 0 }}
          pointerEvents="none"
        >
          <Defs>
            <LinearGradient id="life-arc" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#af52de" />
              <Stop offset="0.55" stopColor={work} />
              <Stop offset="1" stopColor="#3cc4bc" />
            </LinearGradient>
          </Defs>
          <Rect
            x={STROKE / 2}
            y={STROKE / 2}
            width={w}
            height={h}
            rx={h / 2}
            fill="none"
            stroke="url(#life-arc)"
            strokeOpacity={life === "running" ? (still ? 1 : 0.55) : 0.7}
            strokeWidth={STROKE}
          />
          {run && (
            <AnimatedRect
              x={STROKE / 2}
              y={STROKE / 2}
              width={w}
              height={h}
              rx={h / 2}
              fill="none"
              stroke="url(#life-arc)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={[arc, perimeter - arc]}
              strokeDashoffset={offset}
            />
          )}
        </Svg>
      )}
      {children}
    </View>
  );
}

function useReducedMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setOn,
    );
    return () => sub.remove();
  }, []);
  return on;
}
