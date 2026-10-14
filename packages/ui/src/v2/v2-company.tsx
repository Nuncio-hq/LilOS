import { ArrowRightIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, StateDot } from "./v2-bits";
import type { V2Activity, V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";

/* Company home: the board-level view. What the company is doing, who is
   doing it, what needs you. Numbers first, then the people at work, then
   what happened. Every row opens the thread behind it. */
export function V2CompanyHome({
  company,
  threads,
  agents,
  projects,
  activity,
  onOpen,
  onNeedsYou,
  onAgents,
}: {
  company: string;
  threads: V2Thread[];
  agents: V2Agent[];
  projects: V2Project[];
  activity: V2Activity[];
  onOpen: (id: string) => void;
  onNeedsYou: () => void;
  onAgents: () => void;
}) {
  const working = threads.filter((t) => t.state === "working");
  const needs = threads.filter((t) => V2_ATTENTION.includes(t.state));
  const doneToday = activity.filter(
    (a) => a.verb === "finished" && a.ago < 1440,
  ).length;
  const live = agents.filter((a) => !a.soon);
  const busy = new Set(working.map((t) => t.agentId));
  const agent = (id: string) => agents.find((a) => a.id === id);
  const project = (id?: string) => projects.find((p) => p.id === id);

  const stats: {
    value: number;
    label: string;
    hint: string;
    onClick?: () => void;
  }[] = [
    {
      value: working.length,
      label: "Working now",
      hint: `${busy.size} of ${live.length} agents busy`,
    },
    {
      value: needs.length,
      label: "Need you",
      hint: "Decide, fix or look",
      onClick: onNeedsYou,
    },
    { value: doneToday, label: "Finished today", hint: "Across all projects" },
    {
      value: live.length,
      label: "Agents",
      hint: "Hermes profiles",
      onClick: onAgents,
    },
  ];

  return (
    <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center px-6">
        <h1 className="font-semibold text-[14px]">{company}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[60rem] px-8 pt-6 pb-12">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-foreground/[0.07] ring-1 ring-foreground/[0.07] lg:grid-cols-4">
            {stats.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={!s.onClick}
                onClick={s.onClick}
                className="bg-[var(--v2-main)] px-5 py-4 text-left transition-colors enabled:hover:bg-foreground/[0.02]"
              >
                <div className="font-semibold text-[28px] tracking-tight tabular-nums leading-none">
                  {s.value}
                </div>
                <div className="mt-2 font-medium text-[13px]">{s.label}</div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {s.hint}
                </div>
              </button>
            ))}
          </div>

          <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-semibold text-[13px]">At work</h2>
                <span className="text-[12px] text-muted-foreground">
                  {working.length} running
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {working.map((t) => {
                  const a = agent(t.agentId);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onOpen(t.id)}
                      className="group rounded-xl px-3.5 py-3 text-left ring-1 ring-foreground/[0.07] transition-colors hover:bg-foreground/[0.02]"
                    >
                      <div className="flex items-center gap-2.5">
                        <HermesAvatar
                          name={a?.name}
                          status="busy"
                          className="size-7"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-[13.5px]">
                            {t.title}
                          </div>
                          <div className="truncate text-[12px] text-muted-foreground">
                            {a?.name} · {project(t.projectId)?.name}
                          </div>
                        </div>
                        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      {t.live && (
                        <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-foreground/[0.035] px-2.5 py-1.5 font-mono text-[11.5px] text-foreground/75">
                          <span className="lilos-v2-breathe inline-block size-1.5 shrink-0 rounded-full border border-work" />
                          <span className="min-w-0 flex-1 truncate">
                            {t.live.step.target}
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {t.live.elapsed}
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {needs.length > 0 && (
                <>
                  <div className="mt-8 mb-3 flex items-baseline justify-between">
                    <h2 className="font-semibold text-[13px]">Needs you</h2>
                    <button
                      type="button"
                      onClick={onNeedsYou}
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      See all
                    </button>
                  </div>
                  <div className="overflow-hidden rounded-xl ring-1 ring-foreground/[0.07]">
                    {needs.slice(0, 4).map((t, i) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className={cn(
                          "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]",
                          i > 0 && "border-foreground/[0.06] border-t",
                        )}
                      >
                        <StateDot state={t.state} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-[13px]">
                            {t.title}
                          </div>
                          <div className="truncate text-[12px] text-muted-foreground">
                            {t.ask?.text ?? t.line}
                          </div>
                        </div>
                        <HermesAvatar
                          name={agent(t.agentId)?.name}
                          className="size-5"
                        />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-semibold text-[13px]">Activity</h2>
                <span className="text-[12px] text-muted-foreground">Today</span>
              </div>
              <ol className="relative">
                {activity.map((e, i) => {
                  const a = agent(e.agentId);
                  return (
                    <li key={e.id} className="relative flex gap-3 pb-4">
                      {i < activity.length - 1 && (
                        <span className="absolute top-6 bottom-0 left-[9.5px] w-px bg-foreground/[0.08]" />
                      )}
                      <HermesAvatar
                        name={a?.name}
                        className="relative size-5 shrink-0"
                      />
                      <button
                        type="button"
                        disabled={!e.threadId}
                        onClick={() => e.threadId && onOpen(e.threadId)}
                        className="min-w-0 flex-1 text-left text-[12.5px] leading-snug enabled:hover:[&_.obj]:underline"
                      >
                        <span className="font-medium">{a?.name}</span>{" "}
                        <span className="text-muted-foreground">{e.verb}</span>{" "}
                        <span className="obj underline-offset-2">
                          {e.object}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                          {project(e.projectId)?.name ?? "No project"} ·{" "}
                          {ago(e.ago)} ago
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

/* Agents: the roster. Each profile with its role, default model, what it is
   doing now and how much it has on. Like an org chart's people page. */
export function V2Agents({
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
    <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center gap-2 px-6">
        <h1 className="font-semibold text-[14px]">Agents</h1>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {live.length}
        </span>
        <button
          type="button"
          className="ml-auto h-7 rounded-full bg-foreground px-3 font-medium text-[12px] text-background active:scale-[0.97]"
        >
          Hire
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[60rem] gap-3 px-8 pt-6 pb-12 sm:grid-cols-2">
          {live.map((a) => {
            const mine = threads.filter((t) => t.agentId === a.id);
            const run = mine.find((t) => t.state === "working");
            const needs = mine.filter((t) =>
              V2_ATTENTION.includes(t.state),
            ).length;
            const active = mine.filter((t) => t.state !== "settled").length;
            const where = Array.from(
              new Set(
                mine
                  .filter((t) => t.state !== "settled")
                  .map((t) => projects.find((p) => p.id === t.projectId)?.name)
                  .filter(Boolean),
              ),
            );
            return (
              <div
                key={a.id}
                className="rounded-2xl p-4 ring-1 ring-foreground/[0.07]"
              >
                <div className="flex items-start gap-3">
                  <HermesAvatar
                    name={a.name}
                    status={run ? "busy" : "online"}
                    className="size-10"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[14px]">{a.name}</div>
                    <div className="text-[12.5px] text-muted-foreground">
                      {a.role}
                    </div>
                  </div>
                  {needs > 0 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-[11px] text-amber-700 dark:text-amber-300">
                      {needs} need you
                    </span>
                  )}
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
                  <div>
                    <dt className="text-muted-foreground">Runs on</dt>
                    <dd className="mt-0.5 truncate font-medium">{a.engine}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="mt-0.5 truncate font-medium">{a.model}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Skills</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">
                      {a.skills}
                    </dd>
                  </div>
                </dl>
                <button
                  type="button"
                  disabled={!run}
                  onClick={() => run && onOpen(run.id)}
                  className="mt-4 flex w-full items-center gap-2 rounded-lg bg-foreground/[0.035] px-2.5 py-2 text-left text-[12px] enabled:hover:bg-foreground/[0.06]"
                >
                  {run ? (
                    <>
                      <span className="lilos-v2-breathe inline-block size-1.5 shrink-0 rounded-full border border-work" />
                      <span className="min-w-0 flex-1 truncate">
                        {run.title}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Idle</span>
                  )}
                </button>
                <div className="mt-2 text-[11.5px] text-muted-foreground">
                  {active} open {active === 1 ? "thread" : "threads"}
                  {where.length > 0 && ` · ${where.join(", ")}`}
                </div>
              </div>
            );
          })}
          {later.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-2xl border border-foreground/15 border-dashed p-4 text-muted-foreground"
            >
              <HermesAvatar name={a.name} className="size-10 opacity-50" />
              <div>
                <div className="font-medium text-[14px] text-foreground/70">
                  {a.name}
                </div>
                <div className="text-[12.5px]">
                  Coming later as an agent runtime
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
