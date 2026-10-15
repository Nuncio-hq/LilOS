import { CircleAlertIcon, CircleDotIcon, SparklesIcon } from "lucide-react";
import { HermesAvatar } from "../shell/avatars";
import { StateDot } from "./v2-bits";
import { RuntimeIcon } from "./v2-runtime";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";
import { IconStat, ProjectChip, StateBar } from "./v2-viz";

/* The roster, sized for a side sheet: one card per agent. Avatar, name,
   runtime logo, a bar of what its threads are doing, then icons with
   numbers. The bottom row opens what it is working on right now. */
export function V2AgentsList({
  agents,
  threads,
  projects,
  onOpen,
}: {
  agents: V2Agent[];
  threads: V2Thread[];
  projects: V2Project[];
  onOpen: (id: string) => void;
}) {
  const live = agents.filter((a) => !a.soon);
  const later = agents.filter((a) => a.soon);
  return (
    <div className="@container px-4 pt-1 pb-6">
      <div className="grid gap-3 @lg:grid-cols-2">
        {live.map((a) => {
          const mine = threads.filter(
            (t) => t.agentId === a.id && t.state !== "settled",
          );
          const run = mine.find((t) => t.state === "working");
          const needs = mine.filter((t) =>
            V2_ATTENTION.includes(t.state),
          ).length;
          const counts = mine.reduce<
            Partial<Record<V2Thread["state"], number>>
          >((m, t) => {
            m[t.state] = (m[t.state] ?? 0) + 1;
            return m;
          }, {});
          const where = Array.from(new Set(mine.map((t) => t.projectId)));
          return (
            <div
              key={a.id}
              className="flex flex-col gap-3 rounded-2xl p-4 ring-1 ring-foreground/[0.07]"
            >
              <div className="flex items-center gap-3">
                <HermesAvatar
                  name={a.name}
                  status={run ? "busy" : "online"}
                  className="size-10"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-[14px]">
                    {a.name}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {a.model}
                  </div>
                </div>
                <RuntimeIcon
                  runtime={a.runtime}
                  className="size-7 rounded-lg"
                />
              </div>
              <StateBar counts={counts} />
              <div className="flex items-center gap-3">
                <IconStat
                  icon={<CircleDotIcon />}
                  value={mine.length}
                  label="Open threads"
                />
                {needs > 0 && (
                  <IconStat
                    icon={<CircleAlertIcon />}
                    value={needs}
                    label="Need you"
                    tone="amber"
                  />
                )}
                <IconStat
                  icon={<SparklesIcon />}
                  value={a.skills ?? 0}
                  label="Skills"
                />
                <span className="ml-auto flex gap-1">
                  {where.map((pid) => {
                    const i = projects.findIndex((p) => p.id === pid);
                    const p = projects[i];
                    return (
                      <ProjectChip
                        key={pid}
                        name={p?.path ? p.name : "No project"}
                        index={p?.path ? i : -1}
                      />
                    );
                  })}
                </span>
              </div>
              <button
                type="button"
                disabled={!run}
                onClick={() => run && onOpen(run.id)}
                className="flex h-8 items-center gap-2 rounded-lg bg-foreground/[0.035] px-2.5 text-left text-[12px] enabled:hover:bg-foreground/[0.06]"
              >
                {run ? (
                  <>
                    <StateDot state="working" />
                    <span className="min-w-0 flex-1 truncate">{run.title}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Idle</span>
                )}
              </button>
            </div>
          );
        })}
        {later.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-3 rounded-2xl border border-foreground/15 border-dashed p-4"
          >
            <RuntimeIcon
              runtime={a.runtime}
              className="size-10 rounded-xl opacity-70"
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-[14px] text-foreground/70">
                {a.name}
              </div>
              <div className="text-[12px] text-muted-foreground">Soon</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
