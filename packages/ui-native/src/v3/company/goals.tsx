import { View } from "react-native";
import { SectionBlock, T } from "../kit";
import { ListRow } from "../rows";
import type { GoalVM, ProjectVM } from "./types";

/* Goals and Projects: what the company is after and where the work lives.
   Neither has a page to open, so the rows are not buttons. */

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: done }}
      className="h-[3px] overflow-hidden rounded-full bg-rule"
    >
      <View className="h-full bg-ink" style={{ width: `${pct}%` }} />
    </View>
  );
}

export function GoalsSection({ goals }: { goals: GoalVM[] }) {
  return (
    <SectionBlock title="Goals">
      {goals.map((g, i) => (
        <ListRow
          key={g.id}
          testID={`goal-${g.id}`}
          last={i === goals.length - 1}
        >
          <View className="gap-1.5">
            <T variant="label">{g.title}</T>
            <T variant="caption" tone="ink2">
              {g.project ? `${g.project} · Due ${g.due}` : `Due ${g.due}`}
            </T>
            <ProgressBar done={g.done} total={g.total} />
            <T variant="caption" tone="ink2">
              {g.total === 0
                ? "No tickets yet"
                : `${g.done} of ${g.total} ${g.total === 1 ? "ticket" : "tickets"} done`}
            </T>
            <T variant="caption" tone="ink3">
              {g.why}
            </T>
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}

export function ProjectsSection({ projects }: { projects: ProjectVM[] }) {
  return (
    <SectionBlock title="Projects">
      {projects.map((p, i) => (
        <ListRow
          key={p.id}
          testID={`project-${p.id}`}
          last={i === projects.length - 1}
        >
          <View className="gap-0.5">
            <View className="flex-row items-baseline justify-between gap-3">
              <T variant="label" className="shrink">
                {p.name}
              </T>
              <T variant="caption" tone="ink3">
                {p.key}
              </T>
            </View>
            <T variant="small" tone="ink2">
              {p.about}
            </T>
            <T variant="caption" tone="ink3" numberOfLines={1}>
              {p.folder}
            </T>
            {p.open === undefined ? null : (
              <T variant="caption" tone="ink2">
                {p.open === 1 ? "1 open ticket" : `${p.open} open tickets`}
              </T>
            )}
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}
