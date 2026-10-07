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
import { SectionTitle } from "../components/bits";

import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import { accessoryWhat } from "./approval-copy";
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
  offlineDetail,
  blockedDetail,
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
  /** #591: second line under "Can't reach" — the last-known disclosure
      ("Showing last known · 2 min ago"). */
  offlineDetail?: string;
  /** #597: second line under "Update needed" — the side to update. */
  blockedDetail?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <ScrollView
      accessibilityLabel={workspace}
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 24 }}
    >
      {(link === "offline" || link === "blocked") && (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenMac}
          className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3 active:opacity-70"
          style={{ borderCurve: "continuous" }}
        >
          <Icon
            name={
              link === "blocked" ? "arrow.down.circle" : "wifi.exclamationmark"
            }
            size={17}
            tone={link === "blocked" ? "warning" : "destructive"}
            weight="medium"
          />
          <View className="flex-1">
            <AppText size="sm">
              {link === "blocked" ? "Update needed" : `Can't reach ${macName}`}
            </AppText>
            {link === "blocked" && blockedDetail ? (
              <AppText size="xs" tone="muted">
                {blockedDetail}
              </AppText>
            ) : (
              offlineDetail && (
                <AppText size="xs" tone="muted">
                  {offlineDetail}
                </AppText>
              )
            )}
          </View>
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

      {(company.length > 0 || projects.length > 0) && (
        <SectionTitle title="Channels" />
      )}
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
   Music mini-player slot): tapping it opens Activity — and when a handler is
   passed (D-#19), one tap approves it. `inline` = the tab bar is minimized,
   so only a short summary fits beside it. */
export function NeedsYouAccessory({
  approvals,
  placement,
  onApprove,
  onReview,
  onOpen,
}: {
  approvals: Approval[];
  placement: "regular" | "inline";
  /** Approve pill — absent while approval lands in a later slice (#158). */
  onApprove?: (id: string) => void;
  /** #595: a plan ask's **Review** pill — opens the plan in its thread.
      Falls back to onOpen when absent (prototype rows). */
  onReview?: (id: string) => void;
  onOpen: () => void;
}) {
  const top = approvals[0];
  if (!top) return null;
  /* #652: the one-line description reads like the thread card — the
     human sentence first (never the bare `patch {…}` tool call), and a
     last-known ask leads with "Last known" so truncation can't hide it. */
  const what = accessoryWhat(top);
  /* A last-known card's tap opens the ask's own thread read-only — the
     Approve/Review pill is gone anyway; Activity stays for live asks. */
  const open = top.lastKnown && onReview ? () => onReview(top.id) : onOpen;
  if (placement === "inline")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          top.lastKnown
            ? `${approvals.length} waiting on you, last known`
            : `${approvals.length} waiting on you`
        }
        onPress={open}
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
      accessibilityLabel={
        top.lastKnown
          ? `${top.employee} needs you, last known: ${what}. Open thread`
          : `${top.employee} needs you: ${what}. Open Activity`
      }
      onPress={open}
      className="flex-1 flex-row items-center gap-3 pr-2 pl-3"
    >
      <View className={top.lastKnown ? "opacity-50" : ""}>
        <Orb tone={top.tone} size={28} badge={false} />
      </View>
      <View className="min-w-0 flex-1">
        <AppText
          size="sm"
          weight="semibold"
          numberOfLines={1}
          tone={top.lastKnown ? "muted" : "default"}
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
      {/* #591: last-known asks offer no dead Approve while offline. */}
      {/* #595: a plan's pill is **Review** — it opens the plan in its
          thread; nothing approves a plan sight-unseen. Command approvals
          keep the one-tap Approve (AC-2). */}
      {!top.lastKnown && top.primary === "review" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Review ${top.employee}'s plan`}
          onPress={() => (onReview ?? onOpen)(top.id)}
          hitSlop={6}
          className="h-8 items-center justify-center rounded-full bg-primary px-3.5 active:opacity-70"
        >
          <AppText
            size="sm"
            weight="semibold"
            tone="inverse"
            className="text-[14px]"
          >
            Review
          </AppText>
        </Pressable>
      )}
      {onApprove &&
        !top.lastKnown &&
        (top.primary ?? "approve") === "approve" &&
        top.kind !== "question" && (
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
        )}
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
  /* #591: a last-known row keeps the state's shape but loses the live
     tint — muted line, no accent, no working dots, no state ring. */
  const stale = e.lastKnown === true;
  const waiting = e.state === "needs-you" && !stale;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${e.name}, ${e.role}. ${e.now}`}
      onPress={onPress}
      className="flex-row items-center gap-3 pl-3 active:bg-fill"
    >
      {/* #652: the whole row dims on last-known — orb and title too,
          not only the now line (#591's reviewer note). */}
      <View className={stale ? "opacity-50" : ""}>
        <Orb tone={e.tone} state={stale ? "idle" : e.state} />
      </View>
      <View className="min-w-0 flex-1 flex-row items-center py-3 pr-4">
        <View className="min-w-0 flex-1">
          <View className="flex-row items-baseline gap-1.5">
            <AppText
              weight="semibold"
              tone={stale ? "muted" : "default"}
              className="text-[17px] leading-[22px]"
            >
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
            {e.state === "working" && !stale && <Dots />}
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
