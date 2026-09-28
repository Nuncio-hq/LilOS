import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MacLink } from "../app/mac-status-card";
import { AppText } from "../components/app-text";
import { Icon } from "../components/icon";
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

/* The Mac this phone drives (the laptop button on Home, like Claude's
   environment button): is it reachable, how (host + route), what's
   answering (relay + engine), and the way out (Forget). */
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
  return (
    <View className="flex-1 bg-background">
      <SheetHeader title="" onDone={onDone} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 12,
          gap: 22,
        }}
      >
        <View className="items-center gap-2">
          <View
            className="size-[68px] items-center justify-center rounded-[20px] bg-card"
            style={{ borderCurve: "continuous" }}
          >
            <Icon name="laptopcomputer" size={34} tone="foreground" />
          </View>
          <Text className="font-bold tracking-tight text-[30px] leading-[36px] text-foreground">
            {mac.name}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View
              className={`size-[7px] rounded-full ${online ? "bg-success" : mac.link === "offline" ? "bg-destructive" : "bg-muted-foreground"}`}
            />
            <AppText size="xs" tone="muted" weight="medium">
              {online
                ? `Connected ${mac.route}`
                : mac.link === "offline"
                  ? "Can't reach it"
                  : "Reconnecting…"}
            </AppText>
          </View>
          {mac.link === "offline" && (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              className="mt-1 h-9 justify-center rounded-full bg-primary px-4 active:opacity-70"
            >
              <AppText size="sm" weight="semibold" tone="inverse">
                Try again
              </AppText>
            </Pressable>
          )}
        </View>

        <Group title="Connection">
          <Fact label="Host" value={mac.host} mono first />
          <Fact
            label="Relay"
            value={`LilOS relay ${mac.relay.version}`}
            detail={
              online
                ? `${mac.relay.latency ?? ""} · seen ${mac.relay.lastSeen}`
                : `Last seen ${mac.relay.lastSeen}`
            }
          />
          <Fact
            label="Engine"
            value={`${mac.engine.name} ${mac.engine.version}`}
          />
        </Group>

        <Group title="This phone">
          <Fact label="Paired" value={mac.paired} first />
          <Fact
            label="Can"
            value="Message, approve, review"
            detail="Hiring and editing employees stays on the Mac."
          />
        </Group>

        <View
          className="overflow-hidden rounded-[18px] bg-card"
          style={{ borderCurve: "continuous" }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={onForget}
            className="h-[50px] justify-center px-4 active:bg-muted"
          >
            <AppText tone="destructive" weight="medium">
              Forget this Mac
            </AppText>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function Fact({
  label,
  value,
  detail,
  mono,
  first,
}: {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
  first?: boolean;
}) {
  return (
    <View className="flex-row pl-4">
      <View
        className={`min-h-[50px] flex-1 flex-row items-center gap-3 py-2.5 pr-4 ${first ? "" : "border-border border-t"}`}
      >
        <AppText tone="muted" className="w-[70px] text-[15px]">
          {label}
        </AppText>
        <View className="min-w-0 flex-1 items-end">
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            className={`text-foreground ${mono ? "font-mono text-[12.5px]" : "text-[15px]"}`}
          >
            {value}
          </Text>
          {detail && (
            <AppText size="xs" tone="muted" className="text-right">
              {detail}
            </AppText>
          )}
        </View>
      </View>
    </View>
  );
}
