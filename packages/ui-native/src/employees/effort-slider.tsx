import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, PanResponder, View } from "react-native";
import Svg, { Circle, G, Line } from "react-native-svg";
import { AppText } from "../components/app-text";

/* Reasoning effort, "neural network" style — the mobile twin of the web
   EffortSlider (packages/ui/src/chat/effort-slider.tsx): the filled part of
   the capsule is a small network of nodes and links; the further right, the
   brighter the links and the more signals travel along them. Tap or drag;
   it snaps to the model's real levels. Same seed, so the same network as the
   web. */

const THUMB = 26;
const HEIGHT = 32;
const NODES = 26;
const SIGNALS = 8;

function network() {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const nodes = Array.from({ length: NODES }, () => ({
    x: 2 + rnd() * 96,
    y: 18 + rnd() * 64,
    r: 1.3 + rnd() * 1.2,
    delay: rnd() * 3,
  })).sort((a, b) => a.x - b.x);
  const links: [number, number][] = [];
  nodes.forEach((_, i) => {
    for (let j = i + 1; j < Math.min(nodes.length, i + 3); j++)
      links.push([i, j]);
  });
  const signals = Array.from({ length: SIGNALS }, () => ({
    link: links[Math.floor(rnd() * links.length)] ?? [0, 1],
    dur: 0.9 + rnd() * 1.1,
  }));
  return { nodes, links, signals };
}

/* hsl → hex: React Native gradients take hex. */
function hsl(h: number, s: number, l: number) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

export function EffortSlider({
  efforts,
  index,
  label,
  onPick,
}: {
  efforts: string[];
  index: number;
  label: (e: string) => string;
  onPick: (effort: string) => void;
}) {
  const { nodes, links, signals } = useMemo(network, []);
  const [w, setW] = useState(0);
  const last = efforts.length - 1;
  const i = Math.max(index, 0);
  const t = last ? i / last : 0;
  const hue = 235 + 60 * t;

  // The fill glides to the new level instead of jumping.
  const pos = useRef(new Animated.Value(t)).current;
  useEffect(() => {
    Animated.timing(pos, {
      toValue: t,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pos, t]);

  // Nodes twinkle in two alternating sets; signals run along their links.
  const twinkle = useRef(new Animated.Value(0)).current;
  const travel = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.timing(twinkle, {
        toValue: 1,
        duration: 3000,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: false,
      }),
    );
    const b = Animated.loop(
      Animated.timing(travel, {
        toValue: 1,
        duration: 1400,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    a.start();
    b.start();
    return () => {
      a.stop();
      b.stop();
    };
  }, [twinkle, travel]);

  // Tap or drag anywhere on the capsule; snaps to the nearest level.
  const pick = useRef((_x: number) => {});
  pick.current = (x: number) => {
    if (!w || last <= 0) return;
    const n = Math.round(
      Math.min(1, Math.max(0, (x - THUMB / 2) / (w - THUMB))) * last,
    );
    const e = efforts[n];
    if (e && n !== index) onPick(e);
  };
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => pick.current(e.nativeEvent.locationX),
        onPanResponderMove: (e) => pick.current(e.nativeEvent.locationX),
      }),
    [],
  );

  const edge = pos.interpolate({
    inputRange: [0, 1],
    outputRange: [THUMB / 2, Math.max(w - THUMB / 2, THUMB / 2)],
  });
  const px = (p: number, of: number) => (p / 100) * of;
  const on = twinkle.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.25, 1, 0.25],
  });
  const off = twinkle.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 0.25, 1],
  });

  return (
    <View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Reasoning effort"
        accessibilityValue={{ text: label(efforts[i] ?? "") }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => {
          const n = i + (e.nativeEvent.actionName === "increment" ? 1 : -1);
          const next = efforts[n];
          if (next) onPick(next);
        }}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        className="justify-center rounded-full bg-muted"
        style={{
          height: HEIGHT,
          boxShadow:
            i === last && last > 0
              ? "0 0 14px 2px rgba(217,70,239,0.45)"
              : undefined,
        }}
        {...pan.panHandlers}
      >
        <Animated.View
          pointerEvents="none"
          className="absolute top-0 bottom-0 left-0 overflow-hidden rounded-full"
          style={{
            width: edge,
            experimental_backgroundImage: [
              {
                type: "linear-gradient",
                direction: "to right",
                colorStops: [
                  { color: "#172554" },
                  { color: hsl(hue, 70, 30 + 18 * t) },
                ],
              },
            ],
          }}
        >
          {w > 0 && (
            <Svg width={w} height={HEIGHT}>
              {links.map(([a, b]) => (
                <Line
                  key={`${a}-${b}`}
                  x1={px(nodes[a].x, w)}
                  y1={px(nodes[a].y, HEIGHT)}
                  x2={px(nodes[b].x, w)}
                  y2={px(nodes[b].y, HEIGHT)}
                  stroke="#c4b5fd"
                  strokeWidth={0.8}
                  strokeOpacity={0.18 + 0.55 * t}
                />
              ))}
              {[0, 1].map((set) => (
                <AnimatedG key={set} opacity={set ? off : on}>
                  {nodes
                    .filter((_, k) => k % 2 === set)
                    .map((n) => (
                      <Circle
                        key={`${n.x}-${n.y}`}
                        cx={px(n.x, w)}
                        cy={px(n.y, HEIGHT)}
                        r={n.r}
                        fill="#ffffff"
                      />
                    ))}
                </AnimatedG>
              ))}
              {signals
                .slice(0, Math.round(t * SIGNALS))
                .map(({ link, dur }) => {
                  const [a, b] = link.map((k) => nodes[k]);
                  const phase = travel.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 1.4 / dur],
                  });
                  const along = Animated.modulo(phase, 1);
                  return (
                    <AnimatedCircle
                      key={`${a.x}-${b.x}-${dur}`}
                      r={1.8}
                      fill="#f0abfc"
                      cx={along.interpolate({
                        inputRange: [0, 1],
                        outputRange: [px(a.x, w), px(b.x, w)],
                      })}
                      cy={along.interpolate({
                        inputRange: [0, 1],
                        outputRange: [px(a.y, HEIGHT), px(b.y, HEIGHT)],
                      })}
                    />
                  );
                })}
            </Svg>
          )}
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full bg-white"
          style={{
            width: THUMB,
            height: THUMB,
            top: (HEIGHT - THUMB) / 2,
            transform: [{ translateX: Animated.subtract(edge, THUMB / 2) }],
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
          }}
        />
      </View>
      <View className="mt-1.5 flex-row justify-between px-1">
        <AppText size="xs" tone="muted">
          Faster
        </AppText>
        <AppText size="xs" tone="muted">
          Smarter
        </AppText>
      </View>
    </View>
  );
}
