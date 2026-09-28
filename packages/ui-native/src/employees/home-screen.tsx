import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  LayoutAnimation,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { MacLink } from "../app/mac-status-card";
import { AppText } from "../components/app-text";
import { LargeTitle, SectionTitle } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import type { Approval, ChannelRow, EmployeeRow, ProjectGroup } from "./types";

/* Home, as an iOS list under a large title: Employees, then Channels
   grouped by project. The chrome is the system's — glass bar buttons (Mac,
   compose), the glass tab bar with the "needs you" accessory
   riding above it — so this component is only the scrolling content. */
export function EmployeesHomeScreen({
  workspace,
  macName,
  link,
  employees,
  company,
  projects,
  onOpenMac,
  onOpenEmployee,
  onOpenChannel,
}: {
  workspace: string;
  macName: string;
  link: MacLink;
  employees: EmployeeRow[];
  company: ChannelRow[];
  projects: ProjectGroup[];
  onOpenMac: () => void;
  onOpenEmployee: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 24 }}
    >
      <LargeTitle title={workspace} />
      {link === "offline" && (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenMac}
          className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3 active:opacity-70"
          style={{ borderCurve: "continuous" }}
        >
          <Icon
            name="wifi.exclamationmark"
            size={17}
            tone="destructive"
            weight="medium"
          />
          <AppText size="sm" className="flex-1">
            {`Can't reach ${macName}`}
          </AppText>
          <AppText size="sm" tone="none" className="text-primary">
            Details
          </AppText>
        </Pressable>
      )}

      <SectionTitle title="Employees" />
      {employees.map((e, i) => (
        <EmployeeItem
          key={e.id}
          e={e}
          last={i === employees.length - 1}
          onPress={() => onOpenEmployee(e.id)}
        />
      ))}

      <SectionTitle title="Channels" />
      {company.map((c) => (
        <Channel key={c.id} c={c} onPress={() => onOpenChannel(c.id)} />
      ))}
      {projects.map((p) => {
        const closed = !!collapsed[p.id];
        const unread = p.channels.reduce((n, c) => n + (c.unread ?? 0), 0);
        return (
          <View key={p.id}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${p.name}, ${closed ? "collapsed" : "expanded"}`}
              onPress={() => {
                LayoutAnimation.configureNext(
                  LayoutAnimation.create(240, "easeInEaseOut", "opacity"),
                );
                setCollapsed((s) => ({ ...s, [p.id]: !closed }));
              }}
              className="h-11 flex-row items-center gap-3 px-4 active:bg-fill"
            >
              <View
                className="h-[26px] w-[30px] items-center justify-center rounded-[7px] bg-fill"
                style={{ borderCurve: "continuous" }}
              >
                <Text className="font-semibold text-[10.5px] tracking-wide text-subtle-foreground">
                  {p.key}
                </Text>
              </View>
              <AppText weight="semibold" className="flex-1 text-[17px]">
                {p.name}
              </AppText>
              {closed && unread > 0 && <Count n={unread} />}
              <Icon
                name={closed ? "chevron.right" : "chevron.down"}
                size={12}
                tone="muted-foreground"
                weight="semibold"
              />
            </Pressable>
            {!closed &&
              p.channels.map((c) => (
                <Channel
                  key={c.id}
                  c={c}
                  inset
                  onPress={() => onOpenChannel(c.id)}
                />
              ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

/* The oldest request waiting on you, as the tab bar's bottom accessory (the
   Music mini-player slot): one tap approves it, tapping the rest opens
   Activity. `inline` = the tab bar is minimized, so only a short summary
   fits beside it. */
export function NeedsYouAccessory({
  approvals,
  placement,
  onApprove,
  onOpen,
}: {
  approvals: Approval[];
  placement: "regular" | "inline";
  onApprove: (id: string) => void;
  onOpen: () => void;
}) {
  const top = approvals[0];
  if (!top) return null;
  const what = top.command
    ? keepFlags(top.command)
    : top.file
      ? top.file.name
      : top.reason;
  if (placement === "inline")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${approvals.length} waiting on you`}
        onPress={onOpen}
        className="flex-1 flex-row items-center gap-2 px-3"
      >
        <Orb tone={top.tone} size={22} badge={false} />
        <AppText
          size="sm"
          weight="semibold"
          numberOfLines={1}
          className="flex-1"
        >
          {approvals.length === 1
            ? `${top.employee} needs you`
            : `${approvals.length} need you`}
        </AppText>
      </Pressable>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${top.employee} needs you: ${what}. Open Activity`}
      onPress={onOpen}
      className="flex-1 flex-row items-center gap-3 pr-2 pl-3"
    >
      <Orb tone={top.tone} size={28} badge={false} />
      <View className="min-w-0 flex-1">
        <AppText
          size="sm"
          weight="semibold"
          numberOfLines={1}
          className="text-[14px] leading-[18px]"
        >
          {approvals.length > 1
            ? `${top.employee} · +${approvals.length - 1} more`
            : `${top.employee} needs you`}
        </AppText>
        <AppText
          size="xs"
          tone="muted"
          numberOfLines={1}
          className="text-[12.5px] leading-4"
        >
          {what}
        </AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Approve ${top.employee}`}
        onPress={() => onApprove(top.id)}
        hitSlop={6}
        className="h-8 items-center justify-center rounded-full bg-primary px-3.5 active:opacity-70"
      >
        <AppText
          size="sm"
          weight="semibold"
          tone="inverse"
          className="text-[14px]"
        >
          Approve
        </AppText>
      </Pressable>
    </Pressable>
  );
}

/* A Messages-style row: orb, name + role, what they're doing, time; the
   hairline starts where the text does. */
function EmployeeItem({
  e,
  last,
  onPress,
}: {
  e: EmployeeRow;
  last: boolean;
  onPress: () => void;
}) {
  const waiting = e.state === "needs-you";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${e.name}, ${e.role}. ${e.now}`}
      onPress={onPress}
      className="flex-row items-center gap-3 pl-3 active:bg-fill"
    >
      <Orb tone={e.tone} state={e.state} />
      <View className="min-w-0 flex-1 flex-row items-center py-3 pr-4">
        <View className="min-w-0 flex-1">
          <View className="flex-row items-baseline gap-1.5">
            <AppText weight="semibold" className="text-[17px] leading-[22px]">
              {e.name}
            </AppText>
            <AppText
              tone="muted"
              numberOfLines={1}
              className="shrink text-[15px]"
            >
              {e.role}
            </AppText>
          </View>
          <View className="mt-0.5 flex-row items-center gap-1.5">
            {e.ticket && (
              <Text className="font-medium text-[13px] text-muted-foreground">
                {e.ticket}
              </Text>
            )}
            <Text
              numberOfLines={1}
              className={`shrink text-[15px] leading-5 ${waiting ? "font-medium text-accent-text" : "text-muted-foreground"}`}
            >
              {e.now}
            </Text>
            {e.state === "working" && <Dots />}
          </View>
        </View>
        <View className="mb-5 flex-row items-center gap-1.5 self-center pl-2">
          <AppText tone="muted" className="text-[15px]">
            {e.when}
          </AppText>
          <Icon
            name="chevron.right"
            size={11}
            tone="muted-foreground"
            weight="semibold"
          />
        </View>
        {!last && (
          <View className="absolute right-0 bottom-0 left-0 h-[0.5px] bg-border" />
        )}
      </View>
    </Pressable>
  );
}

function Channel({
  c,
  inset,
  onPress,
}: {
  c: ChannelRow;
  inset?: boolean;
  onPress: () => void;
}) {
  const unread = (c.unread ?? 0) > 0 || !!c.activeTone;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`#${c.name}${c.unread ? `, ${c.unread} unread` : ""}`}
      onPress={onPress}
      className={`h-11 flex-row items-center gap-3 pr-4 active:bg-fill ${inset ? "pl-[58px]" : "pl-4"}`}
    >
      <View className="w-[30px] items-center">
        <Icon
          name="number"
          size={16}
          tone={unread ? "foreground" : "muted-foreground"}
          weight={unread ? "semibold" : "regular"}
        />
      </View>
      <Text
        numberOfLines={1}
        className={`flex-1 text-[17px] ${unread ? "font-semibold text-foreground" : "text-foreground"}`}
      >
        {c.name}
      </Text>
      {c.activeTone && (
        <View className="flex-row items-center gap-1.5">
          <Orb tone={c.activeTone} size={18} />
          <Dots />
        </View>
      )}
      {!!c.unread && <Count n={c.unread} />}
    </Pressable>
  );
}

/* Unread count as an iOS badge: tint fill, white numerals. */
function Count({ n }: { n: number }) {
  return (
    <View className="h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5">
      <Text className="font-semibold text-[13px] text-primary-foreground">
        {String(n)}
      </Text>
    </View>
  );
}

/* Typing dots: a soft wave running left to right while someone works. */
function Dots() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View className="flex-row gap-[3px]">
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          className="size-1 rounded-full bg-work"
          style={{
            opacity: v.interpolate({
              inputRange: [0, 0.2 + i * 0.2, 0.4 + i * 0.2, 1],
              outputRange: [0.25, 1, 0.25, 0.25],
              extrapolate: "clamp",
            }),
          }}
        />
      ))}
    </View>
  );
}

/* Lines break only between arguments, and a flag stays with its value
   ("--env dev"): non-breaking hyphens + a no-break space after a flag. */
function keepFlags(command: string) {
  return command
    .replace(/(^|\s)(-{1,2}[\w-]+) (?=[^-\s])/g, "$1$2\u00a0")
    .replace(/-/g, "\u2011");
}
