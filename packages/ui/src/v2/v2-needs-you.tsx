import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, STATE_WORD, StateDot } from "./v2-bits";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";

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
  const groups: { title: string; hint: string; items: V2Thread[] }[] = [
    {
      title: "Decide",
      hint: "Approvals and questions",
      items: rows.filter((t) => t.state === "needs"),
    },
    {
      title: "Fix",
      hint: "Turns that failed",
      items: rows.filter((t) => t.state === "failed"),
    },
    {
      title: "Look",
      hint: "Finished since you last checked",
      items: rows.filter((t) => t.state === "unseen"),
    },
  ].filter((g) => g.items.length > 0);
  return (
    <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center px-6">
        <h1 className="font-semibold text-[14px]">Needs you</h1>
        <span className="ml-2 text-[12px] text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[44rem] px-6 pt-4 pb-10">
          {groups.length === 0 && (
            <div className="grid place-items-center pt-24 text-center">
              <p className="font-medium text-[15px]">You're all caught up</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Agents will bring things back here when they need you.
              </p>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.title} className="mb-8">
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="font-semibold text-[13px]">{g.title}</h2>
                <span className="text-[12px] text-muted-foreground">
                  {g.hint}
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
                      <HermesAvatar
                        name={agent?.name}
                        className="mt-0.5 size-7"
                      />
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
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <StateDot state={t.state} />
                          {STATE_WORD[t.state]} · {agent?.name} ·{" "}
                          {project?.name ?? "No project"}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
