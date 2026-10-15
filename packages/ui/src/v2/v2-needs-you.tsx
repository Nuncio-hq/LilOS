import { CheckCheckIcon, EyeIcon, HandIcon, WrenchIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, StateDot } from "./v2-bits";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";
import { ProjectChip } from "./v2-viz";

/* Everything that came back to you, across projects, in one calm list.
   Grouped by what you have to do: decide, fix, look. */
export function V2NeedsYou({
  threads,
  agents,
  projects,
  onOpen,
}: {
  threads: V2Thread[];
  agents: V2Agent[];
  projects: V2Project[];
  onOpen: (id: string) => void;
}) {
  const rows = threads.filter((t) => V2_ATTENTION.includes(t.state));
  const groups: {
    title: string;
    icon: typeof HandIcon;
    cls: string;
    items: V2Thread[];
  }[] = [
    {
      title: "Decide",
      icon: HandIcon,
      cls: "text-amber-500",
      items: rows.filter((t) => t.state === "needs"),
    },
    {
      title: "Fix",
      icon: WrenchIcon,
      cls: "text-red-500",
      items: rows.filter((t) => t.state === "failed"),
    },
    {
      title: "Look",
      icon: EyeIcon,
      cls: "text-primary",
      items: rows.filter((t) => t.state === "unseen"),
    },
  ].filter((g) => g.items.length > 0);
  return (
    <div className="px-4 pt-1 pb-6">
      {groups.length === 0 && (
        <div className="grid place-items-center gap-3 pt-24 text-center">
          <CheckCheckIcon className="size-8 text-emerald-500" />
          <p className="font-medium text-[15px]">All caught up</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.title} className="mb-8">
          <div className="mb-2 flex items-center gap-2">
            <g.icon className={cn("size-4", g.cls)} />
            <h2 className="font-semibold text-[13px]">{g.title}</h2>
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {g.items.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-2xl bg-background/70 ring-1 ring-foreground/[0.07] dark:bg-white/[0.03]">
            {g.items.map((t, i) => {
              const agent = agents.find((a) => a.id === t.agentId);
              const project = projects.find((p) => p.id === t.projectId);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpen(t.id)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]",
                    i > 0 && "border-foreground/[0.06] border-t",
                  )}
                >
                  <HermesAvatar name={agent?.name} className="mt-0.5 size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-[13.5px]">
                        {t.title}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
                        {ago(t.ago)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
                      {t.ask?.text ?? t.line}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 self-center">
                    <ProjectChip
                      name={project?.name ?? "No project"}
                      index={project ? projects.indexOf(project) : -1}
                    />
                    <StateDot state={t.state} />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
