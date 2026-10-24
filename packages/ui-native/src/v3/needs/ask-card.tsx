import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { Avatar, PersonName, T, Tag } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM } from "../types";

/* What one ask says and how it is answered. The card around it (stack,
   swipe, stamps) is stack-card.tsx. Engine and gateway asks may omit the
   reasons; a row is drawn only when its text exists. */

/** "Approve → what happens", one line; the whole sentence is in Details. */
function Consequence({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <T variant="small" tone="ink2" numberOfLines={1}>
      <Text className="font-semibold text-ink">{`${label} `}</Text>
      {`→ ${text}`}
    </T>
  );
}

function QuestionOptions({
  options,
  onAnswer,
}: {
  options: string[];
  onAnswer: (option: string) => void;
}) {
  return (
    <View className="gap-2.5">
      {options.map((option, i) => {
        const first = i === 0;
        return (
          <Pressable
            key={option}
            testID={`ask-option-${i}`}
            accessibilityRole="button"
            accessibilityLabel={option}
            onPress={() => onAnswer(option)}
            className={`h-12 flex-row items-center justify-center gap-2 rounded-full px-5 active:opacity-70 ${first ? "bg-ink" : "bg-paper"}`}
          >
            <Text
              numberOfLines={1}
              className={`shrink font-semibold text-[16px] ${first ? "text-paper" : "text-ink"}`}
            >
              {option}
            </Text>
            {first ? (
              <Text className="text-[12.5px] text-paper opacity-60">
                default
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function PlanActions({
  onApprove,
  onDeny,
  onOpenThread,
}: {
  onApprove: () => void;
  onDeny: () => void;
  onOpenThread?: () => void;
}) {
  return (
    <View className="gap-2.5">
      {onOpenThread ? (
        <Pressable
          testID="ask-read-plan"
          accessibilityRole="button"
          accessibilityLabel="Read the plan"
          onPress={onOpenThread}
          className="h-11 items-center justify-center rounded-full bg-paper active:opacity-60"
        >
          <Text className="font-semibold text-[16px] text-ink">
            Read the plan
          </Text>
        </Pressable>
      ) : null}
      <DecisionButtons
        size="lg"
        onSoft
        approveLabel="Approve plan"
        denyLabel="Reject plan"
        onApprove={onApprove}
        onDeny={onDeny}
        testIDPrefix="ask-plan"
      />
    </View>
  );
}

/** The sheet has something the card does not already say. */
const hasDetails = (ask: AskVM) =>
  ask.kind !== "plan" &&
  Boolean(ask.why || ask.ifYes || ask.ifNo || ask.spend || ask.fallback);

export function AskCard({
  ask,
  onApprove,
  onDeny,
  onAnswer,
  onOpenThread,
  onDetails,
}: {
  ask: AskVM;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (option: string) => void;
  /** Absent when the ask has no thread to read. */
  onOpenThread?: () => void;
  /** Opens the full reasons, cost and fallback. */
  onDetails: () => void;
}) {
  const approval = ask.kind === "approval";
  return (
    <View className="flex-1 gap-3 p-5">
      <View className="flex-row items-center gap-3">
        <Avatar person={ask.from} size={36} />
        <View className="flex-1 gap-0.5">
          <PersonName person={ask.from} />
          <T variant="caption" tone="ink2">
            {`waiting ${ask.waiting}`}
          </T>
        </View>
        <Tag>{ask.tag}</Tag>
      </View>
      <T variant="heading" numberOfLines={3}>
        {ask.title}
      </T>
      {ask.why ? (
        <T variant="small" tone="ink2" numberOfLines={2}>
          {ask.why}
        </T>
      ) : null}
      {approval ? (
        <View className="gap-1">
          <Consequence label="Approve" text={ask.ifYes} />
          <Consequence label="Deny" text={ask.ifNo} />
        </View>
      ) : null}
      {hasDetails(ask) ? (
        <Pressable
          testID="ask-details-open"
          accessibilityRole="button"
          accessibilityLabel="Details"
          onPress={onDetails}
          hitSlop={8}
          className="flex-row items-center gap-1 self-start active:opacity-60"
        >
          <T variant="small" tone="ink2" className="font-semibold">
            Details
          </T>
          <Icon
            name="chevron.right"
            size={11}
            weight="semibold"
            tone="muted-foreground"
          />
        </Pressable>
      ) : null}
      <View className="mt-auto pt-1">
        {ask.kind === "question" && ask.options?.length ? (
          <QuestionOptions options={ask.options} onAnswer={onAnswer} />
        ) : ask.kind === "plan" ? (
          <PlanActions
            onApprove={onApprove}
            onDeny={onDeny}
            onOpenThread={onOpenThread}
          />
        ) : approval ? (
          <DecisionButtons
            size="lg"
            onSoft
            onApprove={onApprove}
            onDeny={onDeny}
            testIDPrefix="ask"
          />
        ) : null}
      </View>
    </View>
  );
}
