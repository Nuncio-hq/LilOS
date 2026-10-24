import { type ReactNode, useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  type TextProps,
  View,
} from "react-native";
import { DOT, INK, STATUS_WORD } from "../status";
import type { Person, Status } from "../types";

/* The v3 look on the phone: warm paper, ink text, hairlines instead of
   boxes, a serif for titles, sans for everything else. Colour is only ever
   a status. */

const SERIF = { fontFamily: "Charter" } as const;

type Variant = "title" | "heading" | "body" | "small" | "caption" | "label";
type Tone = "ink" | "ink2" | "ink3" | "paper";

const VARIANT: Record<Variant, string> = {
  title: "text-[34px] leading-[40px] font-bold",
  heading: "text-[21px] leading-[27px] font-semibold",
  body: "text-[16px] leading-[23px]",
  small: "text-[14.5px] leading-[20px]",
  caption: "text-[12.5px] leading-[17px]",
  label: "text-[15px] leading-[20px] font-semibold",
};

const TONE: Record<Tone, string> = {
  ink: "text-ink",
  ink2: "text-ink-2",
  ink3: "text-ink-3",
  paper: "text-paper",
};

/** Text on the paper. `title` and `heading` are serif; the rest sans. */
export function T({
  variant = "body",
  tone = "ink",
  className,
  style,
  ...rest
}: TextProps & { variant?: Variant; tone?: Tone; className?: string }) {
  const serif = variant === "title" || variant === "heading";
  return (
    <Text
      accessibilityRole={serif ? "header" : undefined}
      className={`${VARIANT[variant]} ${TONE[tone]} ${className ?? ""}`}
      style={serif ? [SERIF, style] : style}
      {...rest}
    />
  );
}

/** A tab's large serif title, drawn in the content (the native large title
    vanishes after a pushed screen pops). */
export function SerifTitle({ children }: { children: string }) {
  return (
    <T
      variant="title"
      className="px-5 pt-1 pb-3"
      style={{ letterSpacing: -0.4 }}
    >
      {children}
    </T>
  );
}

/** The scrolling page under every v3 tab and pushed screen. */
export function Page({
  children,
  testID,
  footer,
}: {
  children: ReactNode;
  testID?: string;
  footer?: ReactNode;
}) {
  return (
    <View className="flex-1 bg-paper">
      <ScrollView
        testID={testID}
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

/** A status dot; a working one breathes like the Mac's. */
export function StatusDot({
  status,
  size = 8,
}: {
  status: Status;
  size?: number;
}) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (status !== "working") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 0.4,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, v]);
  return (
    <Animated.View
      className={`rounded-full ${DOT[status]}`}
      style={{ width: size, height: size, opacity: v }}
    />
  );
}

/** Dot + the status word in its own ink: "● Needs you". */
export function StatusLabel({
  status,
  label,
}: {
  status: Status;
  /** Replaces the plain status word ("Working · 3 tickets"). */
  label?: string;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <StatusDot status={status} size={7} />
      <Text className={`text-[13px] font-semibold ${INK[status]}`}>
        {label ?? STATUS_WORD[status]}
      </Text>
    </View>
  );
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  return (
    <View
      className="h-px bg-rule"
      style={inset ? { marginLeft: inset } : undefined}
    />
  );
}

/** A section: serif heading, an optional right-hand action, then its rows. */
export function SectionBlock({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <View className="pt-7">
      <View className="flex-row items-baseline justify-between px-5 pb-1.5">
        <T variant="heading">{title}</T>
        {action && onAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}: ${action}`}
            onPress={onAction}
            hitSlop={10}
          >
            <T variant="small" tone="ink2" className="font-semibold">
              {action}
            </T>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** One quiet line under a heading or after a list. */
export function Note({ children }: { children: string }) {
  return (
    <T variant="small" tone="ink2" className="px-5 py-2">
      {children}
    </T>
  );
}

/** The mark of whoever it is: a calm monogram, never a colour. An outside
    worker is square-cornered so the two kinds read apart. */
export function Avatar({
  person,
  size = 36,
}: {
  person: Pick<Person, "name" | "outside">;
  size?: number;
}) {
  return (
    <View
      className="items-center justify-center border border-rule bg-paper-soft"
      style={{
        width: size,
        height: size,
        borderRadius: person.outside ? size * 0.28 : size / 2,
      }}
    >
      <Text
        className="font-semibold text-ink-2"
        style={[SERIF, { fontSize: size * 0.42 }]}
      >
        {person.name.slice(0, 1)}
      </Text>
    </View>
  );
}

export function CeoChip() {
  return (
    <View className="rounded border border-rule px-1.5 py-px">
      <Text className="font-semibold text-[10px] text-ink-2 uppercase tracking-wider">
        CEO
      </Text>
    </View>
  );
}

/** A name, with the CEO chip after it when it is the CEO. */
export function PersonName({
  person,
  variant = "label",
}: {
  person: Pick<Person, "name" | "isCeo">;
  variant?: "label" | "body" | "small";
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <T variant={variant} numberOfLines={1} className="shrink">
        {person.name}
      </T>
      {person.isCeo ? <CeoChip /> : null}
    </View>
  );
}

/** A small outlined tag: a ticket id, a project, a skill. */
export function Tag({ children }: { children: string }) {
  return (
    <View className="self-start rounded-md border border-rule px-1.5 py-0.5">
      <Text className="text-[12px] text-ink-2">{children}</Text>
    </View>
  );
}

/** Two or three views of one list (Threads | Tickets). */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className="mx-5 flex-row rounded-[10px] bg-paper-soft p-0.5"
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            className={`h-8 flex-1 items-center justify-center rounded-lg ${on ? "border border-rule bg-paper" : ""}`}
          >
            <Text
              className={`text-[14px] ${on ? "font-semibold text-ink" : "text-ink-2"}`}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View className="items-center gap-1.5 px-10 py-14">
      <T variant="heading" className="text-center">
        {title}
      </T>
      {body ? (
        <T variant="small" tone="ink2" className="text-center">
          {body}
        </T>
      ) : null}
    </View>
  );
}
