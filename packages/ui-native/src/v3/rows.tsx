import { Pressable, Text, View } from "react-native";
import { Avatar, StatusLabel, T } from "./kit";
import type { ThreadRowVM, TicketRowVM } from "./types";

/* Rows shared by Work, search, an agent's page and a ticket's page: one
   hairline between them, no boxes. */

/** A pressable row with a hairline under it. */
export function ListRow({
  children,
  onPress,
  label,
  testID,
  last,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  label?: string;
  testID?: string;
  last?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      disabled={!onPress}
      onPress={onPress}
      className="px-5 active:bg-paper-soft"
    >
      <View
        className={`py-3 ${last ? "" : "border-b border-rule"}`}
        style={{ minHeight: 56 }}
      >
        {children}
      </View>
    </Pressable>
  );
}

export function ThreadRow({
  row,
  onPress,
  last,
}: {
  row: ThreadRowVM;
  onPress: (id: string) => void;
  last?: boolean;
}) {
  return (
    <ListRow
      onPress={() => onPress(row.id)}
      last={last}
      label={`${row.title}, ${row.agent.name}, ${row.statusWord}`}
    >
      <View className="flex-row items-start gap-3">
        <Avatar person={row.agent} size={34} />
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center justify-between gap-2">
            <T variant="label" numberOfLines={1} className="flex-1">
              {row.title}
            </T>
            {row.unseen ? (
              <View className="size-2 rounded-full bg-st-done" />
            ) : null}
          </View>
          <View className="flex-row items-center gap-2">
            <StatusLabel status={row.status} label={row.statusWord} />
            <Text className="text-[13px] text-ink-3">·</Text>
            <T variant="caption" numberOfLines={1} className="flex-1">
              {`${row.agent.name} · ${row.tag}`}
            </T>
          </View>
          <T variant="caption" tone="ink3" numberOfLines={2}>
            {row.detail}
          </T>
        </View>
      </View>
    </ListRow>
  );
}

export function TicketRow({
  row,
  onPress,
  last,
}: {
  row: TicketRowVM;
  onPress: (id: string) => void;
  last?: boolean;
}) {
  return (
    <ListRow
      onPress={() => onPress(row.id)}
      last={last}
      label={`${row.id}, ${row.title}, ${row.statusWord}`}
    >
      <View className="flex-row items-start gap-3">
        <Avatar person={row.owner} size={34} />
        <View className="flex-1 gap-0.5">
          <T variant="label" numberOfLines={2}>
            {row.title}
          </T>
          <View className="flex-row items-center gap-2">
            <StatusLabel status={row.status} label={row.statusWord} />
            <Text className="text-[13px] text-ink-3">·</Text>
            <T variant="caption" numberOfLines={1} className="flex-1">
              {`${row.id} · ${row.owner.name}`}
            </T>
          </View>
          <T variant="caption" tone="ink3" numberOfLines={2}>
            {row.detail}
          </T>
        </View>
      </View>
    </ListRow>
  );
}

/** Approve / Deny, the same two buttons wherever an ask can be decided.
    Approve is the one filled ink button; Deny sits quietly beside it. */
export function DecisionButtons({
  onApprove,
  onDeny,
  approveLabel = "Approve",
  denyLabel = "Deny",
  size = "md",
  testIDPrefix,
}: {
  onApprove: () => void;
  onDeny: () => void;
  approveLabel?: string;
  denyLabel?: string;
  size?: "sm" | "md" | "lg";
  testIDPrefix?: string;
}) {
  const h = size === "lg" ? "h-[52px]" : size === "md" ? "h-11" : "h-9";
  const text = size === "sm" ? "text-[14px]" : "text-[16px]";
  return (
    <View className="flex-row gap-2.5">
      <Pressable
        testID={testIDPrefix ? `${testIDPrefix}-deny` : undefined}
        accessibilityRole="button"
        accessibilityLabel={denyLabel}
        onPress={onDeny}
        className={`${h} flex-1 items-center justify-center rounded-full bg-paper-soft active:opacity-60`}
      >
        <Text className={`font-semibold text-ink ${text}`}>{denyLabel}</Text>
      </Pressable>
      <Pressable
        testID={testIDPrefix ? `${testIDPrefix}-approve` : undefined}
        accessibilityRole="button"
        accessibilityLabel={approveLabel}
        onPress={onApprove}
        className={`${h} flex-1 items-center justify-center rounded-full bg-ink active:opacity-70`}
      >
        <Text className={`font-semibold text-paper ${text}`}>
          {approveLabel}
        </Text>
      </Pressable>
    </View>
  );
}
