import {
  CheckCircle2Icon,
  CircleDotIcon,
  FlagIcon,
  HandIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  SparklesIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, StateDot } from "./v2-bits";
import type { V2Activity, V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";
import { ProjectChip, StateBar } from "./v2-viz";
import { LiveStepIcon } from "./v2-worklog";

/* What an activity verb looks like: an icon, not a word. */
const VERB_ICON: Record<string, { icon: typeof PlayIcon; cls: string }> = {
  started: { icon: PlayIcon, cls: "text-work" },
  "is running": { icon: CircleDotIcon, cls: "text-work" },
  "asked to run": { icon: FlagIcon, cls: "text-amber-500" },
  asked: { icon: MessageCircleQuestionIcon, cls: "text-amber-500" },
  finished: { icon: CheckCircle2Icon, cls: "text-emerald-500" },
  "failed on": { icon: XCircleIcon, cls: "text-red-500" },
};

function Card({
  title,
  icon,
  count,
  action,
  children,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-2xl p-4 ring-1 ring-foreground/[0.07]", className)}
    >
      <div className="mb-3 flex h-6 items-center gap-2">
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <h2 className="font-semibold text-[13px]">{title}</h2>
        {count !== undefined && (
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

/* Company home: the board at a glance. Numbers as big figures, work as
   bars and rows of icons, words only where a name is needed. */
export function V2CompanyHome({
  company,
  threads,
  agents,
  projects,
  activity,
  onOpen,
  onNeedsYou,
  onAgents,
  onWorking,
  ticketAsks = 0,
}: {
  company: string;
  threads: V2Thread[];
  agents: V2Agent[];
  projects: V2Project[];
  activity: V2Activity[];
  onOpen: (id: string) => void;
  onNeedsYou: () => void;
  onAgents: () => void;
  onWorking: () => void;
  /** Risky ticket asks waiting on you; they count toward Need you. */
  ticketAsks?: number;
}) {
  const working = threads.filter((t) => t.state === "working");
  const needs = threads.filter((t) => V2_ATTENTION.includes(t.state));
  const doneToday = activity.filter(
    (a) => a.verb === "finished" && a.ago < 1440,
  ).length;
  const live = agents.filter((a) => !a.soon);
  const agent = (id: string) => agents.find((a) => a.id === id);
  const pIndex = (id?: string) => projects.findIndex((p) => p.id === id);
  const pName = (id?: string) =>
    projects.find((p) => p.id === id)?.name ?? "No project";
  const open = threads.filter(
    (t) => t.state !== "settled" && t.state !== "snoozed",
  );
  const countsFor = (ts: V2Thread[]) =>
    ts.reduce<Partial<Record<V2Thread["state"], number>>>((m, t) => {
      m[t.state] = (m[t.state] ?? 0) + 1;
      return m;
    }, {});

  const stats = [
    {
      value: working.length,
      label: "Working",
      icon: <CircleDotIcon />,
      cls: "text-work",
      onClick: onWorking,
    },
    {
      value: needs.length + ticketAsks,
      label: "Need you",
      icon: <HandIcon />,
      cls: "text-amber-500",
      onClick: onNeedsYou,
    },
    {
      value: doneToday,
      label: "Done today",
      icon: <CheckCircle2Icon />,
      cls: "text-emerald-500",
    },
    {
      value: live.length,
      label: "Agents",
      icon: <UsersIcon />,
      cls: "text-muted-foreground",
      onClick: onAgents,
    },
  ];

  return (
    <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center px-6">
        <h1 className="font-semibold text-[14px]">{company}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4 px-8 pt-4 pb-12">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={!s.onClick}
                onClick={s.onClick}
                className="flex items-center gap-3 rounded-2xl px-4 py-3.5 text-left ring-1 ring-foreground/[0.07] transition-colors enabled:hover:bg-foreground/[0.02]"
              >
                <span className={cn("[&_svg]:size-5", s.cls)}>{s.icon}</span>
                <span className="font-semibold text-[26px] tracking-tight tabular-nums leading-none">
                  {s.value}
                </span>
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {s.label}
                </span>
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <Card
                title="At work"
                icon={<SparklesIcon />}
                count={working.length}
                action={
                  <button
                    type="button"
                    onClick={onWorking}
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    All
                  </button>
                }
              >
                <div className="flex flex-col gap-1.5">
                  {working.map((t) => {
                    const a = agent(t.agentId);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
                      >
                        <HermesAvatar
                          name={a?.name}
                          status="busy"
                          className="size-8"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-[13.5px]">
                            {t.title}
                          </div>
                          {t.live && (
                            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                              <LiveStepIcon kind={t.live.step.kind} />
                              <span className="min-w-0 truncate font-mono">
                                {t.live.step.target}
                              </span>
                            </div>
                          )}
                        </div>
                        <ProjectChip
                          name={pName(t.projectId)}
                          index={pIndex(t.projectId)}
                        />
                        <span className="w-12 shrink-0 text-right text-[11.5px] text-muted-foreground tabular-nums">
                          {t.live?.elapsed}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              <Card
                title="Projects"
                icon={<FlagIcon />}
                count={projects.length}
              >
                <div className="flex flex-col gap-3">
                  {projects.map((p, i) => {
                    const mine = open.filter((t) => t.projectId === p.id);
                    if (mine.length === 0) return null;
                    const ppl = Array.from(new Set(mine.map((t) => t.agentId)));
                    return (
                      <div key={p.id} className="flex items-center gap-3">
                        <ProjectChip
                          name={p.name}
                          index={i}
                          className="size-6 text-[10px]"
                        />
                        <div className="w-24 shrink-0 truncate font-medium text-[13px]">
                          {p.name}
                        </div>
                        <StateBar counts={countsFor(mine)} className="flex-1" />
                        <span className="flex -space-x-1.5">
                          {ppl.slice(0, 3).map((id) => (
                            <HermesAvatar
                              key={id}
                              name={agent(id)?.name}
                              className="size-5 ring-2 ring-[var(--v2-main)]"
                            />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-muted-foreground">
                    <Legend cls="bg-amber-500" label="Needs you" />
                    <Legend cls="bg-red-500" label="Failed" />
                    <Legend cls="bg-work" label="Working" />
                    <Legend cls="bg-primary" label="New" />
                    <Legend cls="bg-foreground/15" label="Idle" />
                  </div>
                </div>
              </Card>
            </div>

            <div className="flex flex-col gap-4">
              {needs.length > 0 && (
                <Card
                  title="Needs you"
                  icon={<HandIcon />}
                  count={needs.length}
                  action={
                    <button
                      type="button"
                      onClick={onNeedsYou}
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      All
                    </button>
                  }
                >
                  <div className="flex flex-col">
                    {needs.slice(0, 4).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onOpen(t.id)}
                        className="flex h-9 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-foreground/[0.03]"
                      >
                        <StateDot state={t.state} />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {t.title}
                        </span>
                        <HermesAvatar
                          name={agent(t.agentId)?.name}
                          className="size-5"
                        />
                      </button>
                    ))}
                  </div>
                </Card>
              )}

              <Card title="Activity" icon={<CircleDotIcon />}>
                <ol className="flex flex-col">
                  {activity.slice(0, 8).map((e) => {
                    const a = agent(e.agentId);
                    const v = VERB_ICON[e.verb] ?? VERB_ICON.started;
                    const Icon = v.icon;
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          disabled={!e.threadId}
                          onClick={() => e.threadId && onOpen(e.threadId)}
                          title={`${a?.name} ${e.verb} ${e.object}`}
                          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors enabled:hover:bg-foreground/[0.03]"
                        >
                          <span className="relative">
                            <HermesAvatar name={a?.name} className="size-6" />
                            <Icon
                              className={cn(
                                "absolute -right-1 -bottom-1 size-3.5 rounded-full bg-[var(--v2-main)]",
                                v.cls,
                              )}
                            />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px]">
                            {threads.find((t) => t.id === e.threadId)?.title ??
                              e.object}
                          </span>
                          <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                            {ago(e.ago)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-1.5 rounded-full", cls)} />
      {label}
    </span>
  );
}
