import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { AppText } from "../components/app-text";
import { useThemeColor } from "../components/icon";
import { contextFull, contextShare, contextUsedOf } from "./model-rules";
import type { ContextUsage } from "./types";

/* How full a session's context window is (web: SessionUsage, laid out like
   Claude Code's panel). ContextRing is the small gauge beside the thread's
   state; ContextMeter is the full card in Session info: one segmented bar of
   the whole window, then a legend with each part's size and share. */

const k = (x: number) =>
  x >= 1000 ? `${(x / 1000).toFixed(x >= 100_000 ? 0 : 1)}k` : `${x}`;
const pct = (x: number, of: number) =>
  `${of ? Math.min(100, (x / of) * 100).toFixed(x > 0 && x / of < 0.1 ? 1 : 0) : 0}%`;

function parts(c: ContextUsage) {
  /* Live occupancy is one number — when the engine reports it (#415) the
     lifetime counts are session totals, not parts of the window. */
  if (c.context !== undefined)
    return [{ label: "In context", value: contextUsedOf(c), color: "#007aff" }];
  return [
    { label: "Cached context", value: c.cache, color: "#00a19a" },
    {
      label: "New input",
      value: Math.max(0, c.input - c.cache),
      color: "#007aff",
    },
    { label: "Reasoning", value: c.reasoning, color: "#af52de" },
    {
      label: "Replies",
      value: Math.max(0, c.output - c.reasoning),
      color: "#ff9500",
    },
  ];
}
const used = (c: ContextUsage) => contextUsedOf(c);

export function ContextRing({
  c,
  size = 13,
}: {
  c: ContextUsage;
  size?: number;
}) {
  const track = useThemeColor("muted-strong");
  const fill = useThemeColor("muted-foreground");
  const r = size / 2 - 1.5;
  const len = 2 * Math.PI * r;
  const share = contextShare(used(c), c.max);
  return (
    <View className="flex-row items-center gap-1">
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={track}
          strokeWidth={2}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={fill}
          strokeWidth={2}
          fill="none"
          strokeDasharray={`${len}`}
          strokeDashoffset={len * (1 - share)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <AppText
        tone="muted"
        className="text-[13px]"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {contextFull(used(c), c.max) ? "Full" : pct(used(c), c.max)}
      </AppText>
    </View>
  );
}

function Segment({
  share,
  color,
  delay,
}: {
  share: number;
  color: string;
  delay: number;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: share,
      duration: 700,
      delay,
      easing: Easing.bezier(0.2, 0.9, 0.25, 1),
      useNativeDriver: false,
    }).start();
  }, [v, share, delay]);
  return (
    <Animated.View
      style={{
        height: "100%",
        backgroundColor: color,
        width: v.interpolate({
          inputRange: [0, 1],
          outputRange: ["0%", "100%"],
        }),
      }}
    />
  );
}

export function ContextMeter({ c, model }: { c: ContextUsage; model: string }) {
  const ps = parts(c);
  const free = Math.max(0, c.max - used(c));
  return (
    <View className="gap-1.5">
      <AppText size="xs" tone="muted" weight="semibold" className="px-2">
        Context window
      </AppText>
      <View
        className="gap-3 rounded-[18px] bg-card p-4"
        style={{ borderCurve: "continuous" }}
      >
        <View className="flex-row items-baseline justify-between">
          <AppText
            weight="semibold"
            className="text-[22px]"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {contextFull(used(c), c.max) ? "Full" : pct(used(c), c.max)}
          </AppText>
          <AppText
            tone="muted"
            className="text-[13px]"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {`${k(used(c))} / ${c.estimated ? "~" : ""}${k(c.max)}`}
          </AppText>
        </View>
        <View className="h-2 flex-row gap-px overflow-hidden rounded-full bg-fill">
          {ps.map((p, i) => (
            <View
              key={p.label}
              style={{ width: `${contextShare(p.value, c.max) * 100}%` }}
            >
              <Segment share={1} color={p.color} delay={i * 80} />
            </View>
          ))}
        </View>
        <View className="gap-2">
          {[...ps, { label: "Free space", value: free, color: "" }].map((p) => (
            <View key={p.label} className="flex-row items-center gap-2.5">
              <View
                className={`size-2.5 rounded-[3px] ${p.color ? "" : "bg-fill"}`}
                style={p.color ? { backgroundColor: p.color } : undefined}
              />
              <AppText
                tone={p.color ? "default" : "muted"}
                className="flex-1 text-[15px]"
              >
                {p.label}
              </AppText>
              <AppText
                tone="muted"
                className="text-[15px]"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {k(p.value)}
              </AppText>
              <AppText
                tone={p.color ? "default" : "muted"}
                className="w-12 text-right text-[15px]"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {pct(p.value, c.max)}
              </AppText>
            </View>
          ))}
        </View>
        {c.context !== undefined && (
          /* Lifetime throughput, labeled as what it is — the sums count
             every tool-loop call, not what sits in the window (#415). */
          <AppText tone="muted" className="text-[13px]">
            {`This thread — ${k(c.input)} in · ${k(c.output + c.reasoning)} out${c.cache ? ` · ${k(c.cache)} cached` : ""}`}
          </AppText>
        )}
        <View className="flex-row justify-between border-border border-t pt-3">
          <AppText tone="muted" className="text-[13px]">
            Model
          </AppText>
          <AppText className="text-[13px]">{model}</AppText>
        </View>
      </View>
    </View>
  );
}
