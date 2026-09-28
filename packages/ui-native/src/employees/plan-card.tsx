import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Pulse } from "../components/prose";
import { Group, SheetHeader } from "./folder-picker";
import type { PlanRow } from "./types";

/* The plan an employee proposes before editing (issue #175; web: PlanCard).
   In the turn: goal + steps, and while it waits on you Approve / Change… /
   Reject. Approved, the same steps tick off with a progress bar. Replaced or
   rejected plans fold to one line. Tap the card for PlanSheet: every step
   with its files, the risks, and earlier versions. */

export type PlanAction = "approve" | "change" | "reject";

const done = (p: PlanRow) =>
  p.steps.filter((s) => s.status === "completed").length;

function Mark({ s, n }: { s: PlanRow["steps"][number]; n: number }) {
  if (s.status === "completed")
    return (
      <View className="size-5 items-center justify-center rounded-full bg-success">
        <Icon
          name="checkmark"
          size={9}
          weight="bold"
          tone="primary-foreground"
        />
      </View>
    );
  if (s.status === "in_progress")
    return (
      <Pulse>
        <View className="size-5 items-center justify-center rounded-full border-[1.5px] border-work">
          <View className="size-2 rounded-full bg-work" />
        </View>
      </Pulse>
    );
  return (
    <View className="size-5 items-center justify-center rounded-full border border-border">
      <Text className="font-mono text-[10.5px] text-muted-foreground">{n}</Text>
    </View>
  );
}

function Steps({ plan, files }: { plan: PlanRow; files?: boolean }) {
  return (
    <View className="gap-2">
      {plan.steps.map((s, i) => (
        <View key={s.text} className="flex-row gap-2.5">
          <Mark s={s} n={i + 1} />
          <View className="flex-1 gap-1">
            <Text
              className={`text-[15px] leading-5 ${s.status === "completed" || s.status === "cancelled" ? "text-muted-foreground" : "text-foreground"} ${s.status === "cancelled" ? "line-through" : ""}`}
            >
              {s.text}
            </Text>
            {files &&
              s.files?.map((f) => (
                <Text
                  key={f}
                  numberOfLines={1}
                  className="font-mono text-[11.5px] text-subtle-foreground"
                >
                  {f}
                </Text>
              ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function StatusLabel({ plan }: { plan: PlanRow }) {
  const n = done(plan);
  const [text, cls] =
    plan.status === "proposed"
      ? ["Needs your OK", "text-accent-text"]
      : plan.status === "approved"
        ? [
            n === plan.steps.length ? "Done" : `${n}/${plan.steps.length} done`,
            "text-success",
          ]
        : plan.status === "replaced"
          ? [`Replaced by v${plan.version + 1}`, "text-muted-foreground"]
          : ["Rejected", "text-destructive"];
  return (
    <AppText
      size="xs"
      weight="semibold"
      tone="none"
      className={`text-[13px] ${cls}`}
    >
      {text}
    </AppText>
  );
}

function Risks({ risks }: { risks: string[] }) {
  return (
    <View className="gap-1 rounded-xl bg-background px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <Icon
          name="exclamationmark.triangle"
          size={12}
          tone="warning"
          weight="semibold"
        />
        <AppText size="xs" weight="semibold">
          Risks
        </AppText>
      </View>
      {risks.map((r) => (
        <AppText
          key={r}
          size="xs"
          tone="muted"
          className="text-[13px] leading-[18px]"
        >
          {`• ${r}`}
        </AppText>
      ))}
    </View>
  );
}

export function PlanCard({
  plan,
  onAction,
  onOpen,
}: {
  plan: PlanRow;
  onAction?: (a: PlanAction, planId: string) => void;
  /** Opens PlanSheet. */
  onOpen?: () => void;
}) {
  const folded = plan.status === "replaced" || plan.status === "rejected";
  const pct = (done(plan) / plan.steps.length) * 100;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Plan${plan.version > 1 ? ` v${plan.version}` : ""}, ${plan.steps.length} steps`}
      disabled={!onOpen}
      onPress={onOpen}
      className={`gap-3 rounded-[20px] p-3.5 active:opacity-90 ${folded ? "bg-fill" : "bg-card"} ${plan.status === "proposed" ? "border border-primary/40" : ""}`}
      style={{ borderCurve: "continuous" }}
    >
      <View className="flex-row items-center gap-2">
        <Icon
          name="checklist"
          size={15}
          tone={folded ? "muted-foreground" : "foreground"}
        />
        <AppText
          weight="semibold"
          tone={folded ? "muted" : "default"}
          className="text-[15px]"
        >
          {`Plan${plan.version > 1 ? ` v${plan.version}` : ""}`}
        </AppText>
        <AppText size="xs" tone="muted" className="flex-1 text-[13px]">
          {`· ${plan.steps.length} steps`}
        </AppText>
        <StatusLabel plan={plan} />
        {onOpen && (
          <Icon
            name="chevron.right"
            size={11}
            weight="semibold"
            tone="muted-foreground"
          />
        )}
      </View>
      {plan.status === "approved" && (
        <View className="h-1 overflow-hidden rounded-full bg-fill">
          <View
            className="h-full rounded-full bg-success"
            style={{ width: `${pct}%` }}
          />
        </View>
      )}
      {!folded && (
        <>
          <AppText className="text-[15px] leading-5">
            <AppText tone="muted" className="text-[15px]">
              {"Goal · "}
            </AppText>
            {plan.goal}
          </AppText>
          <Steps plan={plan} />
          {plan.status === "proposed" && !!plan.risks?.length && (
            <Risks risks={plan.risks} />
          )}
          {plan.status === "proposed" && onAction && (
            // Its own responder, so a button tap never opens the sheet.
            <View
              onStartShouldSetResponder={() => true}
              className="flex-row gap-2"
            >
              <Pill
                label="Approve"
                onPress={() => onAction("approve", plan.id)}
              />
              <Pill
                label="Change…"
                variant="soft"
                onPress={() => onAction("change", plan.id)}
              />
              <Pill
                label="Reject"
                variant="ghost"
                onPress={() => onAction("reject", plan.id)}
              />
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}

export function PlanSheet({
  plans,
  onDone,
}: {
  /** Every version, oldest first; the last is current. */
  plans: PlanRow[];
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const plan = plans[plans.length - 1];
  if (!plan) return null;
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader
          title={`Plan${plan.version > 1 ? ` v${plan.version}` : ""}`}
          onDone={onDone}
        />
      </View>
      <View className="items-center gap-1.5 px-4">
        <AppText
          weight="semibold"
          className="text-center text-[20px] leading-6"
        >
          {plan.goal}
        </AppText>
        <StatusLabel plan={plan} />
      </View>
      <Group title={`${plan.steps.length} steps`}>
        <View className="px-4 py-3.5">
          <Steps plan={plan} files />
        </View>
      </Group>
      {!!plan.risks?.length && <Risks risks={plan.risks} />}
      {plans.length > 1 && (
        <Group title="Earlier versions">
          {plans
            .slice(0, -1)
            .reverse()
            .map((p, i) => (
              <View
                key={p.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${i ? "border-border border-t" : ""}`}
              >
                <AppText
                  weight="medium"
                  className="text-[15px]"
                >{`v${p.version}`}</AppText>
                <AppText
                  tone="muted"
                  numberOfLines={1}
                  className="flex-1 text-[15px]"
                >
                  {`${p.steps.length} steps`}
                </AppText>
                <StatusLabel plan={p} />
              </View>
            ))}
        </Group>
      )}
    </ScrollView>
  );
}
