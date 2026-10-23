import type { SFSymbol } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useThemeColor } from "../../components/icon";
import { T } from "../kit";
import { Glyph } from "./glyph";
import type { StepKind, StepVM } from "./types";

/* A turn's work, folded: "Worked · 8 steps · 12m". Tap to read the steps.
   A turn the agent is working on right now starts open. */

const KIND_ICON: Record<StepKind, SFSymbol> = {
  read: "doc.text",
  search: "magnifyingglass",
  edit: "pencil",
  run: "terminal",
  web: "globe",
  think: "brain",
  delegate: "arrow.triangle.branch",
};

/** Files, commands and search terms read as code; a thought or a hand-off as words. */
const MONO: Record<StepKind, boolean> = {
  read: true,
  search: true,
  edit: true,
  run: true,
  web: false,
  think: false,
  delegate: false,
};

function Spinner() {
  const color = useThemeColor("ink-3");
  return <ActivityIndicator size="small" color={color} />;
}

function StepRow({ step }: { step: StepVM }) {
  const failed = step.failed === true;
  const meta = [step.meta, step.where].filter(Boolean).join(" · ");
  const hasDiff = step.add !== undefined || step.del !== undefined;
  return (
    <View className="flex-row gap-2.5 py-1.5">
      <View className="h-5 w-4 items-center justify-center">
        {step.running ? (
          <Spinner />
        ) : (
          <Glyph
            name={failed ? "xmark.circle" : KIND_ICON[step.kind]}
            token={failed ? "st-stuck-ink" : "ink-3"}
            size={13}
          />
        )}
      </View>
      <View className="flex-1 gap-0.5">
        <Text
          className={`${MONO[step.kind] ? "font-mono text-[12.5px] leading-[18px]" : "text-[14px] leading-[20px]"} ${failed ? "text-st-stuck-ink" : step.kind === "think" ? "text-ink-2" : "text-ink"}`}
          numberOfLines={step.kind === "think" ? 4 : 2}
        >
          {step.target}
        </Text>
        {meta || hasDiff ? (
          <Text
            className={`text-[12.5px] leading-[17px] ${failed ? "text-st-stuck-ink" : "text-ink-3"}`}
          >
            {meta}
            {meta && hasDiff ? " · " : ""}
            {hasDiff ? `+${step.add ?? 0} −${step.del ?? 0}` : ""}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function WorkFold({
  steps,
  took,
  live,
  testID,
}: {
  steps: StepVM[];
  took?: string;
  live: boolean;
  testID?: string;
}) {
  // Until you tap, the fold follows the turn: open while it runs, shut after.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  if (steps.length === 0) return null;
  const open = chosen ?? live;
  const label = [
    live ? "Working" : "Worked",
    steps.length === 1 ? "1 step" : `${steps.length} steps`,
    took,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => setChosen(!open)}
        hitSlop={6}
        className="min-h-9 flex-row items-center gap-1.5 self-start active:opacity-60"
      >
        <T variant="small" tone="ink2" className="font-medium">
          {label}
        </T>
        <Glyph
          name={open ? "chevron.down" : "chevron.right"}
          token="ink-3"
          size={10}
          weight="semibold"
        />
      </Pressable>
      {open ? (
        <View className="mt-1 ml-1.5 border-rule border-l pl-3">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
