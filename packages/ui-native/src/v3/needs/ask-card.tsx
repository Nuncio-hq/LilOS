import { Pressable, Text, View } from "react-native";
import { Avatar, PersonName, T, Tag } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM } from "../types";

/* What one ask says and how it is answered. The card around it (stack,
   swipe, stamps) is stack-card.tsx. Engine and gateway asks may omit the
   reasons; a row is drawn only when its text exists. */

function Reason({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <View className="gap-0.5">
      <T variant="caption" tone="ink3" className="font-semibold">
        {label}
      </T>
      <T variant="small">{text}</T>
    </View>
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
            className={`h-[52px] flex-row items-center justify-center gap-2 rounded-full px-5 active:opacity-70 ${first ? "bg-ink" : "border border-rule bg-paper"}`}
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
          className="h-11 items-center justify-center rounded-full border border-rule bg-paper active:opacity-60"
        >
          <Text className="font-semibold text-[16px] text-ink">
            Read the plan
          </Text>
        </Pressable>
      ) : null}
      <DecisionButtons
        size="lg"
        approveLabel="Approve plan"
        denyLabel="Reject plan"
        onApprove={onApprove}
        onDeny={onDeny}
        testIDPrefix="ask-plan"
      />
    </View>
  );
}

export function AskCard({
  ask,
  onApprove,
  onDeny,
  onAnswer,
  onOpenThread,
}: {
  ask: AskVM;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (option: string) => void;
  /** Absent when the ask has no thread to read. */
  onOpenThread?: () => void;
}) {
  return (
    <View className="flex-1 gap-3.5 p-5">
      <View className="flex-row items-center gap-3">
        <Avatar person={ask.from} size={40} />
        <View className="flex-1 gap-0.5">
          <PersonName person={ask.from} />
          <T variant="caption" tone="ink2">
            {`waiting ${ask.waiting}`}
          </T>
        </View>
        <Tag>{ask.tag}</Tag>
      </View>
      <T variant="heading">{ask.title}</T>
      <T variant="body">{ask.ask}</T>
      <Reason label="Why" text={ask.why} />
      <Reason label="If you approve" text={ask.ifYes} />
      <Reason label="If you deny" text={ask.ifNo} />
      {ask.spend ? (
        <T variant="caption" tone="ink2">
          {ask.spend}
        </T>
      ) : null}
      {ask.fallback ? (
        <T variant="caption" tone="ink2">
          {ask.fallback}
        </T>
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
        ) : ask.kind === "approval" ? (
          <DecisionButtons
            size="lg"
            onApprove={onApprove}
            onDeny={onDeny}
            testIDPrefix="ask"
          />
        ) : null}
      </View>
    </View>
  );
}
