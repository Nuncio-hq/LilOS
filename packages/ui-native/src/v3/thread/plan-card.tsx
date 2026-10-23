import { Text, View } from "react-native";
import { T } from "../kit";
import { Glyph } from "./glyph";
import type { PlanVM } from "./types";

/* A plan in the conversation: the goal, the steps and what could go wrong, as
   the agent proposed it. Quiet, like the rest of the thread: ink and hairlines,
   no colour (approving and rejecting are not statuses). */

const WORD: Record<PlanVM["status"], string> = {
  proposed: "Waiting for your OK",
  approved: "Approved",
  rejected: "Rejected",
  replaced: "Replaced by a newer plan",
};

const MARK = {
  done: "checkmark.circle.fill",
  running: "circle.inset.filled",
  pending: "circle",
} as const;

export function PlanCard({ plan }: { plan: PlanVM }) {
  const title = plan.version > 1 ? `Plan · version ${plan.version}` : "Plan";
  return (
    <View
      testID="thread-plan"
      className={`gap-3 rounded-2xl border border-rule p-4 ${plan.status === "replaced" || plan.status === "rejected" ? "opacity-60" : ""}`}
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <T variant="label">{title}</T>
        <T variant="caption" tone="ink3">
          {WORD[plan.status]}
        </T>
      </View>
      {plan.goal ? (
        <T variant="small">
          <Text className="font-semibold">{"Goal: "}</Text>
          {plan.goal}
        </T>
      ) : null}
      <View className="gap-2.5">
        {plan.steps.map((s) => (
          <View key={s.key} className="flex-row items-start gap-2.5">
            <View className="pt-[3px]">
              <Glyph
                name={MARK[s.state]}
                token={s.state === "pending" ? "ink-3" : "ink"}
                size={15}
              />
            </View>
            <View className="flex-1 gap-0.5">
              <T variant="small">{s.text}</T>
              {s.files.map((f) => (
                <T
                  key={f}
                  variant="caption"
                  tone="ink3"
                  className="font-mono"
                  numberOfLines={1}
                >
                  {f}
                </T>
              ))}
            </View>
          </View>
        ))}
      </View>
      {plan.risks.length > 0 ? (
        <View className="gap-1">
          <T variant="caption" className="font-semibold">
            Risks
          </T>
          {plan.risks.map((r) => (
            <T key={r} variant="caption" tone="ink2">
              {r}
            </T>
          ))}
        </View>
      ) : null}
    </View>
  );
}
