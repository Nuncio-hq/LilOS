import { View } from "react-native";
import { AppText } from "../components/app-text";
import { Icon } from "../components/icon";

/* The Mac this phone is (or is about to be) paired with. */
export function MacCard({
  name,
  host,
  detail,
}: {
  name: string;
  /** #688 AC-2: an IP:port is small secondary text, never the headliner. */
  host?: string;
  /** Plain line instead of the host, e.g. "via Tailscale". */
  detail?: string;
}) {
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border p-4">
      <Icon name="laptopcomputer" size={22} />
      <View className="flex-1 gap-0.5">
        <AppText weight="semibold" numberOfLines={1}>
          {name}
        </AppText>
        {host && (
          <AppText size="xs" tone="muted" className="font-mono">
            {host}
          </AppText>
        )}
        {detail && (
          <AppText size="sm" tone="muted">
            {detail}
          </AppText>
        )}
      </View>
    </View>
  );
}
