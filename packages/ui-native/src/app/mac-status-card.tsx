import { ActivityIndicator, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Icon, useThemeColor } from "../components/icon";

export type MacLink = "reconnecting" | "online" | "offline";

/* Step 6 — top of Home on every launch after pairing: reconnecting, connected,
   or can't reach the Mac (asleep / Tailscale off) with Try again. */
export function MacStatusCard({
  name,
  link,
  routeLabel,
  lastConnected,
  onRetry,
}: {
  name: string;
  link: MacLink;
  routeLabel: string;
  /** e.g. "5 min ago" */
  lastConnected: string;
  onRetry: () => void;
}) {
  const spinner = useThemeColor("muted-foreground");
  return (
    <View className="gap-4 rounded-2xl bg-secondary p-4">
      <View className="flex-row items-center gap-3">
        <Icon name="laptopcomputer" size={24} />
        <View className="flex-1">
          <AppText weight="semibold">{name}</AppText>
          <View className="flex-row items-center gap-1.5">
            {link === "reconnecting" ? (
              <ActivityIndicator size="small" color={spinner} />
            ) : (
              <View
                className={`size-2 rounded-full ${link === "online" ? "bg-success" : "bg-destructive"}`}
              />
            )}
            <AppText size="sm" tone="muted">
              {link === "reconnecting"
                ? "Reconnecting…"
                : link === "online"
                  ? `Connected ${routeLabel}`
                  : `Can't reach it · last connected ${lastConnected}`}
            </AppText>
          </View>
        </View>
      </View>
      {link === "offline" && (
        <>
          <AppText size="sm" tone="muted">
            Your Mac may be asleep, or Tailscale is off on one of the devices.
            Your employees' work is safe — it continues when the Mac is back.
          </AppText>
          <Button label="Try again" onPress={onRetry} />
        </>
      )}
    </View>
  );
}
