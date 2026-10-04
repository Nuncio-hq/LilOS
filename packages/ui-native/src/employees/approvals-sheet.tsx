import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Card, CommandLine, LargeTitle, Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import { approvalSentence } from "./approval-copy";
import type { Approval } from "./types";

/* Everything waiting on you, oldest first — as a modal sheet (onClose) or
   as the Activity tab. No "Approve all" on purpose:
   each request carries different risk (a migration vs a test run). */
export function ApprovalsSheet({
  approvals,
  onApprove,
  onDeny,
  onOpen,
  onClose,
}: {
  approvals: Approval[];
  /** Approve/Deny pills render only when their handler is passed (D-#19) —
      absent while approving lands in a later slice (#158). */
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  onOpen: (id: string) => void;
  /** Omit when shown as a tab under a native large title (no own header). */
  onClose?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background">
      <ScrollView
        contentInsetAdjustmentBehavior={onClose ? "never" : "automatic"}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          gap: 12,
        }}
      >
        {onClose && (
          <View collapsable={false}>
            <View className="items-center pt-2">
              <View className="h-[5px] w-10 rounded-full bg-muted-strong" />
            </View>
            <View className="flex-row items-end px-[22px] pt-4 pb-3">
              <View className="flex-1">
                <Text className="font-bold tracking-tight text-[32px] leading-9 text-foreground">
                  Needs you
                </Text>
                <AppText size="xs" tone="muted" className="mt-1">
                  {approvals.length === 0
                    ? "Nothing waiting. Your team is unblocked."
                    : `${approvals.length} waiting · oldest first`}
                </AppText>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                className="size-9 items-center justify-center rounded-full bg-muted"
              >
                <Icon
                  name="xmark"
                  size={13}
                  weight="bold"
                  tone="subtle-foreground"
                />
              </Pressable>
            </View>
          </View>
        )}
        {!onClose && (
          <View className="-mx-4">
            <LargeTitle title="Needs you" />
          </View>
        )}
        {approvals.length === 0 && (
          <View className="items-center gap-3 pt-16">
            <View className="size-14 items-center justify-center rounded-full bg-accent-soft">
              <Icon name="checkmark" size={22} weight="bold" tone="primary" />
            </View>
            <AppText tone="muted">All clear</AppText>
          </View>
        )}
        {approvals.map((a) => (
          <Card key={a.id}>
            <View className="flex-row items-center gap-2.5">
              <Orb tone={a.tone} size={30} state="needs-you" badge={false} />
              <View className="min-w-0 flex-1">
                <AppText size="sm" weight="semibold" numberOfLines={1}>
                  {a.employee}
                </AppText>
                <AppText size="xs" tone="muted" numberOfLines={1}>
                  {`${a.session} · ${a.age} ago`}
                </AppText>
              </View>
            </View>
            <AppText size="sm" className="mt-2.5 leading-5">
              {approvalSentence(a)}
            </AppText>
            {a.command && (
              <View className="mt-2.5">
                <CommandLine command={a.command} />
              </View>
            )}
            {a.file && (
              <View className="mt-2.5 flex-row items-center gap-2.5 rounded-xl bg-background px-3 py-2.5">
                <Icon name="doc.text" size={16} tone="subtle-foreground" />
                <View className="min-w-0 flex-1">
                  <Text
                    numberOfLines={1}
                    className="font-mono text-[13px] text-foreground"
                  >
                    {a.file.name}
                  </Text>
                  <AppText size="xs" tone="muted">
                    {a.file.detail}
                  </AppText>
                </View>
              </View>
            )}
            <View className="mt-3 flex-row items-center gap-2">
              {onApprove && a.kind !== "question" && (
                <Pill label="Approve" onPress={() => onApprove(a.id)} />
              )}
              {onDeny && (
                <Pill
                  label={a.kind === "question" ? "Cancel" : "Deny"}
                  variant="soft"
                  onPress={() => onDeny(a.id)}
                />
              )}
              <View className="flex-1" />
              <Pill label="Open" variant="ghost" onPress={() => onOpen(a.id)} />
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
