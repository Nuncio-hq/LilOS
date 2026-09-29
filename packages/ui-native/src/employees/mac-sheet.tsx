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
import { Icon, type IconTone } from "../components/icon";
import { Rise } from "../components/rise";
import { Group, SheetHeader } from "./folder-picker";

export type MacDetail = {
  name: string;
  host: string;
  /** "via Tailscale" / "on this network" */
  route: string;
  link: MacLink;
  /** Relay facts the phone knows after the handshake. */
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
  onRetry,
  onForget,
  onDone,
}: {
  mac: MacDetail;
  onRetry: () => void;
  onForget: () => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const online = mac.link === "online";
  const offline = mac.link === "offline";
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
            <LinkHero link={mac.link} />
            <View className="items-center gap-1.5">
              <Text className="text-center font-bold text-[26px] text-foreground leading-[32px] tracking-tight">
                {mac.name}
              </Text>
              <View
                className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${online ? "bg-success/12" : offline ? "bg-destructive/10" : "bg-fill"}`}
              >
                <View
                  className={`size-[7px] rounded-full ${online ? "bg-success" : offline ? "bg-destructive" : "bg-muted-foreground"}`}
                />
                <AppText
                  size="xs"
                  weight="semibold"
                  tone="none"
                  className={`text-[12.5px] ${online ? "text-success" : offline ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {online
                    ? `Connected ${mac.route}`
                    : offline
                      ? "Can't reach it"
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
            </View>
            {offline && <Pill label="Try again" size="sm" onPress={onRetry} />}
          </View>
        </Rise>

        <Rise delay={80}>
          <View className="flex-row gap-2.5">
            <Tile
              icon="bolt.fill"
              tone={online ? "success" : "muted-foreground"}
              value={online ? (mac.relay.latency ?? "—") : "—"}
              label={`${online ? "seen" : "last seen"} ${mac.relay.lastSeen}`}
            />
            <Tile
              icon="point.3.connected.trianglepath.dotted"
              tone="primary"
              value={mac.relay.version}
              label="Relay"
            />
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
              <Can icon="bubble.left.and.bubble.right.fill" label="Message" />
              <Can icon="checkmark.seal.fill" label="Approve" />
              <Can icon="eye.fill" label="Review" />
              <Can icon="person.badge.plus" label="Hire" off />
            </View>
          </Group>
          <AppText size="xs" tone="muted" className="mt-1.5 px-2">
            {`Paired ${mac.paired} · hiring stays on the Mac`}
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

/* Phone · · · · Mac — the connection you're looking at, drawn. */
function LinkHero({ link }: { link: MacLink }) {
  const online = link === "online";
  const offline = link === "offline";
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!online) return;
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 1600,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [online, t]);
  const W = 96;
  return (
    <View className="flex-row items-center gap-3">
      <Badge icon="iphone" />
      <View style={{ width: W, height: 14 }} className="justify-center">
        <View className="flex-row justify-between">
          {Array.from({ length: 9 }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed dots
              key={i}
              className={`size-[4px] rounded-full ${offline ? "bg-destructive/40" : "bg-muted-strong"}`}
              style={offline && i === 4 ? { opacity: 0 } : undefined}
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
      </View>
      <Badge icon="laptopcomputer" big />
    </View>
  );
}

function Badge({ icon, big }: { icon: SFSymbol; big?: boolean }) {
  const s = big ? 76 : 56;
  return (
    <View
      className="items-center justify-center bg-card"
      style={{
        width: s,
        height: s,
        borderRadius: s * 0.3,
        borderCurve: "continuous",
        shadowColor: "#000",
        shadowOpacity: 0.08,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <Icon name={icon} size={big ? 36 : 26} tone="foreground" />
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
      <AppText size="xs" tone="muted" numberOfLines={1}>
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
  off?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={off ? `${label}: only on the Mac` : label}
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
