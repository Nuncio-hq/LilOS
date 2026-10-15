import { SparklesIcon } from "lucide-react";
import { HermesAvatar } from "../shell/avatars";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import { LiveStepIcon } from "./v2-worklog";

/* Everything running right now, for the side sheet: who, which project,
   the step it is on, and the last lines of its output. A card opens the
   thread. */
export function V2AtWork({
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
  const working = threads
    .filter((t) => t.state === "working")
    .sort((a, b) => a.ago - b.ago);
  if (working.length === 0)
    return (
      <div className="grid place-items-center gap-3 pt-24 text-center">
        <SparklesIcon className="size-8 text-muted-foreground/60" />
        <p className="font-medium text-[15px]">Nobody is working</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-3 px-4 pt-1 pb-6">
      {working.map((t) => {
        const a = agents.find((x) => x.id === t.agentId);
        const i = projects.findIndex((p) => p.id === t.projectId);
        const p = projects[i];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(t.id)}
            className="flex flex-col gap-2.5 rounded-2xl p-3.5 text-left ring-1 ring-foreground/[0.07] transition-colors hover:bg-foreground/[0.02]"
          >
            <div className="flex items-center gap-3">
              <HermesAvatar name={a?.name} status="busy" className="size-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[13.5px]">
                  {t.title}
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {a?.name}
                </div>
              </div>
              <ProjectChip
                name={p?.path ? p.name : "No project"}
                index={p?.path ? i : -1}
              />
              <span className="w-12 shrink-0 text-right text-[11.5px] text-muted-foreground tabular-nums">
                {t.live?.elapsed}
              </span>
            </div>
            {t.live && (
              <div className="overflow-hidden rounded-xl bg-zinc-950 px-3 py-2 font-mono text-[11.5px] text-zinc-300 leading-relaxed">
                <div className="flex min-w-0 items-center gap-1.5 text-zinc-100">
                  <LiveStepIcon kind={t.live.step.kind} />
                  <span className="min-w-0 truncate">{t.live.step.target}</span>
                </div>
                {t.live.tail?.slice(-2).map((l) => (
                  <div key={l} className="truncate text-zinc-500">
                    {l}
                  </div>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
