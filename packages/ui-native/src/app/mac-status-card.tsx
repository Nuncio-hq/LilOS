import { ActivityIndicator, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Icon, useThemeColor } from "../components/icon";

export type MacLink = "reconnecting" | "online" | "offline" | "blocked";

/* Step 6 — top of Home on every launch after pairing: reconnecting, connected,
   can't reach the Mac (asleep / Tailscale off) with Try again, or blocked on
   a version mismatch with the update line (#597). */
export function MacStatusCard({
  name,
  link,
  routeLabel,
  lastConnected,
  blockedDetail,
  onRetry,
}: {
  name: string;
  link: MacLink;
  routeLabel: string;
  /** e.g. "5 min ago" */
  lastConnected: string;
  /** #597: the "Update LilOS on this iPhone / on the Mac" line while
      `link === "blocked"`. */
  blockedDetail?: string;
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
                className={`size-2 rounded-full ${link === "online" ? "bg-success" : link === "blocked" ? "bg-warning" : "bg-destructive"}`}
              />
            )}
            <AppText size="sm" tone="muted">
              {link === "reconnecting"
                ? "Reconnecting…"
                : link === "online"
                  ? `Connected ${routeLabel}`
                  : link === "blocked"
                    ? "Update needed"
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
      {link === "blocked" && (
        <>
          <AppText size="sm" tone="muted">
            {blockedDetail ??
              "LilOS versions don't match — update LilOS, then try again."}
          </AppText>
          <Button label="Try again" onPress={onRetry} />
        </>
      )}
    </View>
  );
}
