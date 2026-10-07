import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MacLink } from "../app/mac-status-card";
import { AppText } from "../components/app-text";
import { Pill } from "../components/bits";
import { MacArt, PhoneArt } from "../components/device-art";
import { Icon, type IconTone } from "../components/icon";
import { Rise } from "../components/rise";
import { Group, SheetHeader } from "./folder-picker";

export type MacDetail = {
  name: string;
  host: string;
  /** "via Tailscale" / "on this network" */
  route: string;
  link: MacLink;
  /** Relay facts the phone knows after the handshake. `lastSeen` is the
      reach tile's whole label verbatim ("seen just now", a plain reason,
      "last seen 3 min ago") — the sheet no longer prefixes it (#597). */
  relay: { version: string; latency?: string; lastSeen: string };
  engine: { name: string; version: string };
  paired: string;
};

/* The Mac this phone drives (the laptop button on Home). Top: the link
   itself — phone and Mac with a live dotted line between them (a pulse
   travels while connected; red and broken when it can't reach it). Then
   three glanceable tiles (latency, relay, engine), what this phone may do,
   and the way out. Few words; details are one line each. */
export function MacSheet({
  mac,
  blocked,
  onRetry,
  onForget,
  onDone,
}: {
  mac: MacDetail;
  /** #597 AC-2: a version mismatch is its own blocked state — the update
      line plus the action that takes them to it (e.g. Open TestFlight on
      the phone side; Try again stays alongside it). `side` is the stale
      device — the link badge sits on it (#688 AC-3). */
  blocked?: {
    body: string;
    side?: "phone" | "mac";
    action?: { label: string; onPress: () => void };
  };
  onRetry: () => void;
  onForget: () => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const online = mac.link === "online";
  const offline = mac.link === "offline";
  const blockedLink = mac.link === "blocked";
  return (
    <View className="flex-1 bg-background">
      <SheetHeader title="" onDone={onDone} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 12,
          gap: 24,
        }}
      >
        <Rise>
          <View className="items-center gap-4 pt-1">
            <LinkHero link={mac.link} updateSide={blocked?.side} />
            <View className="items-center gap-1.5">
              <Text className="text-center font-bold text-[26px] text-foreground leading-[32px] tracking-tight">
                {mac.name}
              </Text>
              <View
                className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${online ? "bg-success/12" : offline ? "bg-destructive/10" : blockedLink ? "bg-warning/15" : "bg-fill"}`}
              >
                <View
                  className={`size-[7px] rounded-full ${online ? "bg-success" : offline ? "bg-destructive" : blockedLink ? "bg-warning" : "bg-muted-foreground"}`}
                />
                <AppText
                  size="xs"
                  weight="semibold"
                  tone="none"
                  className={`text-[12.5px] ${online ? "text-success" : offline ? "text-destructive" : blockedLink ? "text-warning" : "text-muted-foreground"}`}
                >
                  {online
                    ? `Connected ${mac.route}`
                    : offline
                      ? "Can't reach it"
                      : blockedLink
                        ? "Update needed"
                        : "Reconnecting…"}
                </AppText>
              </View>
              <Text
                numberOfLines={1}
                ellipsizeMode="middle"
                className="max-w-[300px] font-mono text-[12px] text-muted-foreground"
              >
                {mac.host}
              </Text>
              {/* #688 AC-3: the reach line (a plain offline reason, "seen
                  just now") is a caption here — tiles only exist while
                  they hold data. */}
              <AppText size="xs" tone="muted" className="text-center">
                {mac.relay.lastSeen}
              </AppText>
            </View>
            {offline && <Pill label="Try again" size="sm" onPress={onRetry} />}
            {blockedLink && blocked && (
              <View className="w-full items-center gap-3 px-1">
                <AppText size="sm" tone="muted" className="text-center">
                  {blocked.body}
                </AppText>
                <View className="flex-row gap-2">
                  {blocked.action && (
                    <Pill
                      label={blocked.action.label}
                      size="sm"
                      onPress={blocked.action.onPress}
                    />
                  )}
                  <Pill
                    label="Try again"
                    size="sm"
                    variant={blocked.action ? "soft" : "primary"}
                    onPress={onRetry}
                  />
                </View>
              </View>
            )}
          </View>
        </Rise>

        {/* #688 AC-3: a tile only renders while it holds data — no "—"
            placeholders (the reach line moved up under the status pill,
            and "not running" always carries the engine's name). */}
        <Rise delay={80}>
          <View className="flex-row gap-2.5">
            {mac.relay.latency && (
              <Tile
                icon="bolt.fill"
                tone="success"
                value={mac.relay.latency}
                label="Latency"
              />
            )}
            {mac.relay.version !== "—" && (
              <Tile
                icon="point.3.connected.trianglepath.dotted"
                tone="primary"
                value={mac.relay.version}
                label="Relay"
              />
            )}
            <Tile
              icon="sparkle"
              tone="merged"
              value={mac.engine.version}
              label={mac.engine.name}
            />
          </View>
        </Rise>

        <Rise delay={160}>
          <Group title="This phone can">
            <View className="flex-row justify-around px-2 py-3.5">
              {/* #688 AC-3: nothing here works until a version-mismatch
                  update lands — the whole row reads disabled. */}
              <Can
                icon="bubble.left.and.bubble.right.fill"
                label="Message"
                off={blockedLink ? "available after the update" : undefined}
              />
              <Can
                icon="checkmark.seal.fill"
                label="Approve"
                off={blockedLink ? "available after the update" : undefined}
              />
              <Can
                icon="eye.fill"
                label="Review"
                off={blockedLink ? "available after the update" : undefined}
              />
              <Can icon="person.badge.plus" label="Hire" off />
            </View>
          </Group>
          <AppText size="xs" tone="muted" className="mt-1.5 px-2">
            {blockedLink
              ? `Paired ${mac.paired} · available after the update`
              : `Paired ${mac.paired} · hiring stays on the Mac`}
          </AppText>
        </Rise>

        <Pressable
          accessibilityRole="button"
          onPress={onForget}
          className="h-[50px] items-center justify-center rounded-[18px] bg-destructive/10 active:opacity-70"
          style={{ borderCurve: "continuous" }}
        >
          <AppText tone="destructive" weight="semibold">
            Forget this Mac
          </AppText>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/* Phone · · · · Mac — the connection, drawn. While connected a pulse
   travels phone → Mac → phone and back again, easing at each end; red dots
   and a ✕ when the phone can't reach it. On a version mismatch the update
   badge sits on the device that's stale (#688 AC-3). */
function LinkHero({
  link,
  updateSide,
}: {
  link: MacLink;
  updateSide?: "phone" | "mac";
}) {
  const online = link === "online";
  const offline = link === "offline";
  const blocked = link === "blocked";
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!online) return;
    const ease = Easing.inOut(Easing.cubic);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: 1300,
          easing: ease,
          useNativeDriver: true,
        }),
        Animated.delay(180),
        Animated.timing(t, {
          toValue: 0,
          duration: 1300,
          easing: ease,
          useNativeDriver: true,
        }),
        Animated.delay(180),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [online, t]);
  const W = 96;
  /* The update badge rides on whichever device is stale — bottom edge of
     its art; no `updateSide` known keeps the old mid-line spot. */
  const updateBadge = (
    <Icon name="arrow.down.circle.fill" size={16} tone="warning" />
  );
  return (
    <View className="flex-row items-end gap-4">
      <View>
        <PhoneArt scale={1.05} />
        {blocked && updateSide === "phone" && (
          <View className="absolute -right-1.5 -bottom-1.5 rounded-full bg-background">
            {updateBadge}
          </View>
        )}
      </View>
      <View
        style={{ width: W, height: 14, marginBottom: 22 }}
        className="justify-center"
      >
        <View className="flex-row justify-between">
          {Array.from({ length: 9 }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed dots
              key={i}
              className={`size-[4px] rounded-full ${offline ? "bg-destructive/40" : blocked ? "bg-warning/40" : "bg-muted-strong"}`}
              style={
                (offline || blocked) && i === 4 ? { opacity: 0 } : undefined
              }
            />
          ))}
        </View>
        {online && (
          <Animated.View
            className="absolute size-[10px] rounded-full bg-success"
            style={{
              left: -3,
              shadowColor: "#34c759",
              shadowOpacity: 0.8,
              shadowRadius: 6,
              transform: [
                {
                  translateX: t.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, W - 4],
                  }),
                },
              ],
            }}
          />
        )}
        {offline && (
          <View className="absolute self-center">
            <Icon name="xmark.circle.fill" size={16} tone="destructive" />
          </View>
        )}
        {blocked && !updateSide && (
          <View className="absolute self-center">{updateBadge}</View>
        )}
      </View>
      <View>
        <MacArt scale={1.05} />
        {blocked && updateSide === "mac" && (
          <View className="absolute -right-1.5 -bottom-1.5 rounded-full bg-background">
            {updateBadge}
          </View>
        )}
      </View>
    </View>
  );
}

function Tile({
  icon,
  tone,
  value,
  label,
}: {
  icon: SFSymbol;
  tone: IconTone;
  value: string;
  label: string;
}) {
  return (
    <View
      className="flex-1 gap-1.5 rounded-[18px] bg-card px-3 py-3"
      style={{ borderCurve: "continuous" }}
    >
      <Icon name={icon} size={15} tone={tone} />
      <Text
        numberOfLines={1}
        className="font-semibold text-[17px] text-foreground"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      {/* #597 AC-2: the label can carry the engine's failure reason —
          let it wrap instead of squeezing into one truncated line. */}
      <AppText size="xs" tone="muted">
        {label}
      </AppText>
    </View>
  );
}

function Can({
  icon,
  label,
  off,
}: {
  icon: SFSymbol;
  label: string;
  /** `true` = Mac-only (hire); a string = the reason it's disabled. */
  off?: boolean | string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={
        typeof off === "string"
          ? `${label}: ${off}`
          : off
            ? `${label}: only on the Mac`
            : label
      }
      className="items-center gap-1.5"
      style={off ? { opacity: 0.4 } : undefined}
    >
      <View className="size-11 items-center justify-center rounded-full bg-accent-soft">
        <Icon
          name={icon}
          size={18}
          tone={off ? "muted-foreground" : "primary"}
        />
      </View>
      <AppText size="xs" weight="medium">
        {label}
      </AppText>
    </View>
  );
}
