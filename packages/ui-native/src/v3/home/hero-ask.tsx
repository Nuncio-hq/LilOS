import { Pressable, View } from "react-native";
import { Avatar, Module, PersonName, T, Tag } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM } from "../types";

/* The most urgent ask, decided right on Home: who, what, and the one control
   it needs. The count and the way to the rest is the "Needs you" tile. */

export function HeroAsk({
  ask,
  onApprove,
  onDeny,
  onAnswer,
  onReview,
}: {
  ask: AskVM;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAnswer: (id: string, option: string) => void;
  /** Opens the plan in its thread. */
  onReview: (threadId: string) => void;
}) {
  return (
    <Module title="Needs you">
      <View className="gap-3" testID={`hero-${ask.id}`}>
        <View className="flex-row items-center gap-2.5">
          <Avatar person={ask.from} size={32} />
          <View className="flex-1">
            <PersonName person={ask.from} variant="small" />
            <T variant="caption" tone="ink2">
              {`waiting ${ask.waiting}`}
            </T>
          </View>
          <Tag>{ask.tag}</Tag>
        </View>
        <T variant="body" numberOfLines={2} className="font-semibold">
          {ask.title}
        </T>
        {ask.kind === "plan" && ask.why ? (
          <T variant="small" tone="ink2" numberOfLines={1}>
            {ask.why}
          </T>
        ) : null}
        {ask.kind === "question" && ask.options?.length ? (
          <View className="gap-2">
            {ask.options.map((option, i) => (
              <Pressable
                key={option}
                testID={`hero-option-${i}`}
                accessibilityRole="button"
                accessibilityLabel={option}
                onPress={() => onAnswer(ask.id, option)}
                className={`h-10 items-center justify-center rounded-full px-4 active:opacity-70 ${i === 0 ? "bg-ink" : "bg-paper"}`}
              >
                <T
                  variant="small"
                  tone={i === 0 ? "paper" : "ink"}
                  numberOfLines={1}
                  className="font-semibold"
                >
                  {option}
                </T>
              </Pressable>
            ))}
          </View>
        ) : ask.kind === "plan" ? (
          <View className="gap-2">
            {ask.threadId ? (
              <Pressable
                testID="hero-review-plan"
                accessibilityRole="button"
                accessibilityLabel="Review the plan"
                onPress={() => onReview(ask.threadId as string)}
                className="h-10 items-center justify-center rounded-full bg-ink active:opacity-70"
              >
                <T variant="small" tone="paper" className="font-semibold">
                  Review the plan
                </T>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <DecisionButtons
            size="md"
            onSoft
            onApprove={() => onApprove(ask.id)}
            onDeny={() => onDeny(ask.id)}
            testIDPrefix="hero"
          />
        )}
      </View>
    </Module>
  );
}
