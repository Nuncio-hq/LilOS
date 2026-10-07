import { Pressable, View } from "react-native";
import { AppText } from "../components/app-text";
import { Icon } from "../components/icon";

/* #555: sends parked by Stop (web: NotSentTray above the composer). The
   turn ended before the queued message ran, so it leaves the transcript
   and waits here — "Send now" delivers it as a new turn, "Remove" drops
   it. Each action renders only with its handler; without both the tray
   still shows — the items and the "not sent" label are information, not
   controls (same rule as web's #19). */
export function NotSentTray({
  items,
  onSendNow,
  onRemove,
}: {
  items: { id: string; text: string }[];
  onSendNow?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <View className="mx-4 rounded-2xl border border-primary/30 bg-primary/10 px-3.5 py-2.5 dark:border-primary/40">
      <View className="flex-row items-center gap-1.5">
        <Icon name="stop.circle" size={14} tone="primary" weight="medium" />
        <AppText
          size="xs"
          tone="none"
          weight="semibold"
          className="text-primary"
        >
          {items.length === 1
            ? "1 not sent · turn stopped"
            : `${items.length} not sent · turn stopped`}
        </AppText>
      </View>
      {items.map((m, i) => (
        <View key={m.id} className="mt-1.5 flex-row items-center gap-2.5">
          <AppText
            size="xs"
            tone="none"
            className="w-3.5 font-mono text-primary"
          >
            {i + 1}
          </AppText>
          <AppText
            size="sm"
            numberOfLines={1}
            className="min-w-0 flex-1 text-foreground"
          >
            {m.text}
          </AppText>
          {onSendNow && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send now, message ${i + 1}`}
              onPress={() => onSendNow(m.id)}
              hitSlop={4}
              className="h-8 items-center justify-center rounded-full bg-primary px-3.5 active:opacity-70"
            >
              <AppText size="xs" tone="inverse" weight="semibold">
                Send now
              </AppText>
            </Pressable>
          )}
          {onRemove && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove message ${i + 1}`}
              onPress={() => onRemove(m.id)}
              hitSlop={6}
              className="p-1 active:opacity-60"
            >
              <Icon name="trash" size={15} tone="destructive" />
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}
