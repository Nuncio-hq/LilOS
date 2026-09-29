import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "./app-text";
import { Icon } from "./icon";

/* Shared bits of the employee screens: pill buttons, section rule headers,
   state chips, the "$ command" line and the round glass icon button. */

export function Pill({
  label,
  onPress,
  variant = "primary",
  size = "md",
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "soft" | "ghost";
  size?: "sm" | "md";
}) {
  const box =
    variant === "primary"
      ? "bg-primary"
      : variant === "soft"
        ? "bg-fill"
        : "bg-transparent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      className={`${size === "sm" ? "h-9 px-4" : "h-10 px-[18px]"} items-center justify-center rounded-full active:opacity-70 ${box}`}
    >
      <AppText
        size="sm"
        weight="semibold"
        tone={variant === "primary" ? "inverse" : "default"}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

/** A tab's large title (SF Pro Bold 34, iOS's 16pt margin), drawn in the
    content: the native large title inside the tab bar vanishes after a
    screen pushed on the root stack pops, so the bar keeps only its buttons. */
export function LargeTitle({ title }: { title: string }) {
  return (
    <AppText
      accessibilityRole="header"
      className="px-4 pt-1 font-bold text-[34px] leading-[41px] tracking-tight"
    >
      {title}
    </AppText>
  );
}

/** List section title, like "Pinned" in Messages or "Library" in Music:
    bold 22pt, aligned with the large title's 16pt margin. */
export function SectionTitle({ title }: { title: string }) {
  return (
    <View className="px-4 pt-7 pb-1.5">
      <AppText
        accessibilityRole="header"
        className="font-bold text-[22px] leading-7 tracking-tight"
      >
        {title}
      </AppText>
    </View>
  );
}

/* Session state the way iOS labels status: a filled SF Symbol + a word in
   the same color, no pill behind it. */
const CHIP = {
  done: {
    icon: "checkmark.circle.fill",
    tone: "muted-foreground",
    text: "text-muted-foreground",
    label: "Done",
  },
  "needs-you": {
    icon: "exclamationmark.circle.fill",
    tone: "primary",
    text: "text-accent-text",
    label: "Needs you",
  },
  working: {
    icon: "circle.dotted.circle",
    tone: "work",
    text: "text-work",
    label: "Working",
  },
  failed: {
    icon: "xmark.circle.fill",
    tone: "destructive",
    text: "text-destructive",
    label: "Failed",
  },
  stopped: {
    icon: "stop.circle.fill",
    tone: "muted-foreground",
    text: "text-muted-foreground",
    label: "Stopped",
  },
} as const;

export function StateChip({ state }: { state: keyof typeof CHIP }) {
  const c = CHIP[state];
  return (
    <View className="flex-row items-center gap-1">
      <Icon name={c.icon} size={13} tone={c.tone} weight="semibold" />
      <AppText
        size="xs"
        tone="none"
        weight="semibold"
        className={`text-[13px] ${c.text}`}
      >
        {c.label}
      </AppText>
    </View>
  );
}

export function CommandLine({ command }: { command: string }) {
  return (
    <View className="flex-row rounded-xl bg-background px-3 py-2.5">
      <AppText className="font-mono text-[13px] text-primary">$ </AppText>
      <AppText className="flex-1 font-mono text-[13px] leading-[18px] text-foreground">
        {nonBreaking(command)}
      </AppText>
    </View>
  );
}

/* U+2011 keeps "--repeat-each" on one line; lines break only at spaces. */
export function nonBreaking(command: string) {
  return command.replace(/-/g, "\u2011");
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <View
      className="rounded-[20px] bg-card p-3.5"
      style={{ borderCurve: "continuous" }}
    >
      {children}
    </View>
  );
}
