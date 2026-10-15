import {
  CircleAlertIcon,
  CircleDotIcon,
  CrownIcon,
  PlugIcon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { StateDot } from "./v2-bits";
import { RuntimeIcon } from "./v2-runtime";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";
import { IconStat, ProjectChip, StateBar } from "./v2-viz";
import type { V2Connector } from "./v2-work-types";

/* The roster, sized for a side sheet: one card per agent, every agent the
   same shape. The CEO is a position one of them holds (crown, first card);
   "Make CEO" moves it. Each card: avatar, name, model, runtime logo, a bar of
   what its threads are doing, icon counts, the connectors it can use, then
   what it is working on right now. */
export function V2AgentsList({
  agents,
  threads,
  projects,
  connectors,
  onOpen,
  onMakeCeo,
}: {
  agents: V2Agent[];
  threads: V2Thread[];
  projects: V2Project[];
  connectors: V2Connector[];
  onOpen: (id: string) => void;
  onMakeCeo?: (agentId: string) => void;
}) {
  const live = agents
    .filter((a) => !a.soon)
    .sort(
      (a, b) => Number(b.position === "ceo") - Number(a.position === "ceo"),
    );
  const later = agents.filter((a) => a.soon);
  const nameOf = (id?: string) => agents.find((a) => a.id === id)?.name;
  return (
    <div className="@container px-4 pt-1 pb-6">
      <div className="grid gap-3 @lg:grid-cols-2">
        {live.map((a) => {
          const ceo = a.position === "ceo";
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
          const plugs = connectors.filter((c) => c.agentIds.includes(a.id));
          return (
            <div
              key={a.id}
              data-v2-agent={a.id}
              className={cn(
                "group flex flex-col gap-3 rounded-2xl p-4 ring-1 ring-foreground/[0.07]",
                ceo && "ring-amber-500/30 @lg:col-span-2",
              )}
            >
              <div className="flex items-center gap-3">
                <span className="relative shrink-0">
                  <HermesAvatar
                    name={a.name}
                    status={run ? "busy" : "online"}
                    className="size-10"
                  />
                  {ceo && (
                    <CrownIcon className="absolute -top-2 -right-1 size-4 text-amber-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold text-[14px]">
                      {a.name}
                    </span>
                    {ceo && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 font-semibold text-[10.5px] text-amber-700 dark:text-amber-300">
                        CEO
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {a.model}
                    {a.reportsTo && !ceo && (
                      <> · reports to {nameOf(a.reportsTo)}</>
                    )}
                  </div>
                </div>
                {!ceo && onMakeCeo && (
                  <button
                    type="button"
                    onClick={() => onMakeCeo(a.id)}
                    title={`Make ${a.name} the CEO`}
                    className="flex h-7 items-center gap-1 rounded-full px-2 text-[11.5px] text-muted-foreground opacity-0 ring-1 ring-foreground/10 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <CrownIcon className="size-3" />
                    Make CEO
                  </button>
                )}
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
                {plugs.length > 0 && (
                  <IconStat
                    icon={<PlugIcon />}
                    value={plugs.map((c) => c.name).join(", ")}
                    label="Connectors"
                  />
                )}
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
              <div className="text-[12px] text-muted-foreground">
                Soon · through ACP
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
