import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../components/icon";
import { Module, ProgressBar, StatusDot, T } from "../kit";
import type { GoalVM, ProjectVM } from "./types";

/* Goals and Projects: what the company is after and where the work lives.
   A goal is read-only: its project is one tap away in the Projects module
   below, so a second door to it would only duplicate that. */

/** Lines a module shows before it says "n more". */
const TOP_GOALS = 3;

function GoalRow({ goal }: { goal: GoalVM }) {
  return (
    <View testID={`goal-${goal.id}`} className="gap-1.5 py-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <T variant="small" className="flex-1 font-semibold" numberOfLines={1}>
          {goal.title}
        </T>
        <T variant="caption" tone="ink2">
          {goal.total === 0 ? "No tickets" : `${goal.done} of ${goal.total}`}
        </T>
      </View>
      <ProgressBar value={goal.total > 0 ? goal.done / goal.total : 0} />
      <T variant="caption" tone="ink3" numberOfLines={1}>
        {goal.project ? `${goal.project} · Due ${goal.due}` : `Due ${goal.due}`}
      </T>
    </View>
  );
}

/** Each goal with a progress bar; "more" unfolds the rest in place (goals
    have no page of their own). */
export function GoalsModule({ goals }: { goals: GoalVM[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? goals : goals.slice(0, TOP_GOALS);
  const hidden = goals.length - TOP_GOALS;
  return (
    <Module
      title="Goals"
      count={goals.length}
      footer={
        hidden > 0
          ? {
              label: all ? "Show less" : `${hidden} more`,
              onPress: () => setAll((v) => !v),
            }
          : undefined
      }
    >
      {shown.map((g) => (
        <GoalRow key={g.id} goal={g} />
      ))}
    </Module>
  );
}

export function ProjectsModule({
  projects,
  onOpenProject,
}: {
  projects: ProjectVM[];
  onOpenProject: (projectId: string) => void;
}) {
  return (
    <Module title="Projects" count={projects.length}>
      {projects.map((p) => (
        <Pressable
          key={p.id}
          testID={`project-${p.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${p.name}, ${p.summary}`}
          onPress={() => onOpenProject(p.id)}
          className="flex-row items-center gap-2.5 py-1.5 active:opacity-60"
        >
          {p.status ? (
            <StatusDot status={p.status} />
          ) : (
            <View className="w-2" />
          )}
          <View className="flex-1 gap-px">
            <T variant="small" className="font-semibold" numberOfLines={1}>
              {p.name}
            </T>
            <T variant="caption" tone="ink2" numberOfLines={1}>
              {p.summary}
            </T>
          </View>
          <Icon
            name="chevron.right"
            size={12}
            tone="muted-foreground"
            weight="semibold"
          />
        </Pressable>
      ))}
    </Module>
  );
}
