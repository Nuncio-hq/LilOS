import { Pressable, Text, View } from "react-native";

/** Approve / Deny, the same two buttons wherever an ask can be decided.
    Approve is the one filled ink button; Deny sits quietly beside it. */
export function DecisionButtons({
  onApprove,
  onDeny,
  approveLabel = "Approve",
  denyLabel = "Deny",
  size = "md",
  onSoft = false,
  testIDPrefix,
}: {
  onApprove: () => void;
  onDeny: () => void;
  approveLabel?: string;
  denyLabel?: string;
  size?: "sm" | "md" | "lg";
  /** The buttons sit on a paper-soft surface (a module, a card): Deny is
      drawn in paper there, or it would have no shape of its own. */
  onSoft?: boolean;
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
        className={`${h} flex-1 items-center justify-center rounded-full active:opacity-60 ${onSoft ? "bg-paper" : "bg-paper-soft"}`}
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
