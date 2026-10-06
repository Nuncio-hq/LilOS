import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Card, LargeTitle, Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import { whatLine } from "./approval-copy";
import { isAnswerableQuestion } from "./question-gate";
import type { Approval } from "./types";

/* Everything waiting on you, oldest first — as a modal sheet (onClose) or
   as the Activity tab. No "Approve all" on purpose:
   each request carries different risk (a migration vs a test run). */
export function ApprovalsSheet({
  approvals,
  onApprove,
  onDeny,
  onOpen,
  onReview,
  onClose,
  unreachable,
}: {
  approvals: Approval[];
  /** Approve/Deny pills render only when their handler is passed (D-#19) —
      absent while approving lands in a later slice (#158). */
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  onOpen: (id: string) => void;
  /** #595: a plan ask's **Review** — opens the plan in its thread. Falls
      back to onOpen when absent. */
  onReview?: (id: string) => void;
  /** Omit when shown as a tab under a native large title (no own header). */
  onClose?: () => void;
  /** #591: set while the Mac is unreachable — the list is last-known
     (rows carry `lastKnown`), the sheet says so under the title, and the
     empty state never reads "All clear". `asOf` = last-seen age
     ("2 min ago"). */
  unreachable?: { mac: string; asOf?: string };
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
        {unreachable && (
          <View className="flex-row items-center gap-2.5 rounded-2xl bg-card px-4 py-3">
            <Icon
              name="wifi.exclamationmark"
              size={15}
              tone="destructive"
              weight="medium"
            />
            <AppText size="sm" tone="muted" className="flex-1">
              {`Can't reach ${unreachable.mac} — showing last known${unreachable.asOf ? ` · ${unreachable.asOf}` : ""}`}
            </AppText>
          </View>
        )}
        {approvals.length === 0 &&
          (unreachable ? (
            <View className="items-center gap-3 pt-16">
              <View className="size-14 items-center justify-center rounded-full bg-muted">
                <Icon
                  name="wifi.exclamationmark"
                  size={22}
                  weight="bold"
                  tone="muted-foreground"
                />
              </View>
              <AppText tone="muted">{`Can't reach ${unreachable.mac}`}</AppText>
              <AppText size="sm" tone="muted">
                {`Last known: nothing waiting${unreachable.asOf ? ` · ${unreachable.asOf}` : ""}`}
              </AppText>
            </View>
          ) : (
            <View className="items-center gap-3 pt-16">
              <View className="size-14 items-center justify-center rounded-full bg-accent-soft">
                <Icon name="checkmark" size={22} weight="bold" tone="primary" />
              </View>
              <AppText tone="muted">All clear</AppText>
            </View>
          ))}
        {approvals.map((a) => (
          <Card key={a.id}>
            <View className="flex-row items-center gap-2.5">
              <Orb tone={a.tone} size={30} state="needs-you" badge={false} />
              <View className="min-w-0 flex-1">
                <AppText size="sm" weight="semibold" numberOfLines={1}>
                  {a.employee}
                </AppText>
                <AppText size="xs" tone="muted" numberOfLines={1}>
                  {`${a.lastKnown ? "last known · " : ""}${a.session} · ${a.age} ago`}
                </AppText>
              </View>
            </View>
            {/* #652: human description like everywhere else — the same
                "wants to run · cmd" line as the accessory, no `$ patch {…}`
                terminal box (the in-thread card keeps the command box). */}
            <AppText size="sm" className="mt-2.5 leading-5">
              {whatLine(a)}
            </AppText>
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
              {/* #591: a last-known row offers no dead pills — the tap
                  couldn't reach the Mac anyway. Open still works: it
                  opens the cached thread. */}
              {/* #595: a plan's primary is **Review** — it opens the plan
                  in its thread; nothing approves a plan sight-unseen.
                  Command approvals keep the one-tap Approve (AC-2). */}
              {!a.lastKnown && a.primary === "review" && (
                <Pill
                  label="Review"
                  onPress={() => (onReview ?? onOpen)(a.id)}
                />
              )}
              {!a.lastKnown &&
                onApprove &&
                (a.primary ?? "approve") === "approve" &&
                a.kind !== "question" && (
                  <Pill label="Approve" onPress={() => onApprove(a.id)} />
                )}
              {!a.lastKnown && onDeny && (
                <Pill
                  label={isAnswerableQuestion(a) ? "Skip" : "Deny"}
                  variant="soft"
                  onPress={() => onDeny(a.id)}
                />
              )}
              <View className="flex-1" />
              {/* On a plan card Review IS the open — no second route pill. */}
              {a.primary !== "review" && (
                <Pill
                  label="Open"
                  variant="ghost"
                  onPress={() => onOpen(a.id)}
                />
              )}
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
