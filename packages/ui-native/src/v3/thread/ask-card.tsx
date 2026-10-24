import { Pressable, Text, View } from "react-native";
import { StatusLabel, T } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM } from "../types";

/* The ask this thread waits on, at the bottom of the conversation where the
   agent stopped. It is only drawn while the ask exists: once decided it is gone. */

export function ThreadAskCard({
  ask,
  onApprove,
  onDeny,
  onAnswer,
}: {
  ask: AskVM;
  onApprove: () => void;
  onDeny: () => void;
  onAnswer: (option: string) => void;
}) {
  const lines: { key: string; label: string; text: string }[] = [];
  // A plan's one-line summary is the plan card right above it.
  if (ask.why && ask.kind !== "plan")
    lines.push({ key: "why", label: "Why", text: ask.why });
  if (ask.ifYes) lines.push({ key: "yes", label: "If yes", text: ask.ifYes });
  if (ask.ifNo) lines.push({ key: "no", label: "If no", text: ask.ifNo });
  return (
    <View
      testID="thread-ask"
      className="mx-5 gap-3 rounded-2xl bg-paper-soft p-4"
    >
      <StatusLabel
        status="needs"
        label={`Needs you · waiting ${ask.waiting}`}
      />
      <View className="gap-1">
        <T variant="label">{ask.title}</T>
        {/* A plan's ask only points at the plan, which is right above in this
            thread: no line telling you to go and read it. */}
        {ask.kind === "plan" ? null : (
          <T variant="small" tone="ink2">
            {ask.ask}
          </T>
        )}
      </View>
      {lines.length > 0 ? (
        <View className="gap-1">
          {lines.map((l) => (
            <T key={l.key} variant="caption" tone="ink2">
              <Text className="font-semibold text-ink">{`${l.label}: `}</Text>
              {l.text}
            </T>
          ))}
        </View>
      ) : null}
      {ask.spend ? (
        <T variant="caption" tone="ink3">
          {ask.spend}
        </T>
      ) : null}
      {ask.kind === "question" && ask.options?.length ? (
        <View className="gap-2">
          {ask.options.map((o, i) => (
            <Pressable
              key={o}
              accessibilityRole="button"
              accessibilityLabel={o}
              onPress={() => onAnswer(o)}
              className={`min-h-11 items-center justify-center rounded-full px-4 active:opacity-70 ${i === 0 ? "bg-ink" : "bg-paper"}`}
            >
              <Text
                className={`font-semibold text-[15px] ${i === 0 ? "text-paper" : "text-ink"}`}
              >
                {o}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <DecisionButtons
          onApprove={onApprove}
          onDeny={onDeny}
          onSoft
          approveLabel={ask.kind === "plan" ? "Approve plan" : undefined}
          denyLabel={ask.kind === "plan" ? "Reject plan" : undefined}
          testIDPrefix="thread-ask"
        />
      )}
      {ask.fallback ? (
        <T variant="caption" tone="ink3">
          {ask.fallback}
        </T>
      ) : null}
    </View>
  );
}
