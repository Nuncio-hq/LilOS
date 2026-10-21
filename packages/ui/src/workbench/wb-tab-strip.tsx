import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import {
  CircleDotIcon,
  CpuIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  NetworkIcon,
  PanelRightCloseIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { RefObject } from "react";
import { TabsList } from "../components/ui/tabs";
import { cn } from "../lib/utils";
import type { Plan, PullRequest, WbTab } from "../types";

/* The work panel's tab row — the prototype's: h-11, icon + label + count, the
   open tab underlined, close at the right. Order is fixed (Changes · Files ·
   Terminal · Preview · PR · Background · Plan · Subagents · Browser · Details);
   which of them show is the caller's gating, unchanged. */

export const TAB_ORDER: WbTab[] = [
  "changes",
  "files",
  "terminal",
  "preview",
  "pr",
  "background",
  "plan",
  "subagents",
  "browser",
  "details",
];

/** One tab. Ink is `foreground/70` light / muted dark — the labels must hold
    AA (#609) — and the open one is full ink with the underline lit; the
    underline snaps with `data-active`, no fade (#543: a fade left the old
    tab's underline visibly lit for ~150ms). */
function Trigger({
  tab,
  name,
  icon,
  className,
  children,
  ...rest
}: {
  tab: WbTab;
  name: string;
  icon: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
} & Partial<Record<`data-${string}`, string | boolean | undefined>>) {
  return (
    <TabsPrimitive.Tab
      value={tab}
      data-slot="tabs-trigger"
      data-wb-tab={tab}
      data-wb-name={name}
      className={cn(
        "relative flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] text-foreground/70 outline-none transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
        "after:absolute after:right-2.5 after:-bottom-[7px] after:left-2.5 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 data-active:font-medium data-active:text-foreground dark:data-active:text-foreground data-active:opacity-100 data-active:after:opacity-100",
        className,
      )}
      {...rest}
    >
      {icon}
      <span data-wb-label className="in-[.wb-fold]:hidden">
        {name}
      </span>
      {children}
    </TabsPrimitive.Tab>
  );
}

const count = "font-normal text-muted-foreground/70 tabular-nums";

export type StripState = {
  /** Which tabs the strip shows (gating by caps/probes — unchanged). */
  on: Record<WbTab, boolean>;
  changes: number;
  termRunning: boolean;
  plan?: Plan;
  jobs: number;
  jobsRunning: number;
  helpers: number;
  helpersRunning: number;
  /** The PR the strip names: live forge truth, else the thread's own. */
  pr?: PullRequest | null;
};

export function WbTabStrip({
  listRef,
  s,
  revalidating,
  onClose,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  s: StripState;
  revalidating: boolean;
  onClose: () => void;
}) {
  const { on, plan, pr } = s;
  const prName = pr ? `PR #${pr.number}` : "PR";
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-[var(--v3-line)] border-b pr-2 pl-2">
      <TabsList
        ref={listRef}
        variant="line"
        /* justify-start, not the variant's center: centered overflow clips
           the leftmost tab off the strip's edge (issue #326). */
        /* The variant pins h-7 on horizontal tabs; the strip is the full 44px row
           so the trigger's underline lands on the hairline below. */
        className="no-scrollbar h-full min-w-0 justify-start gap-0.5 overflow-x-auto p-0 group-data-horizontal/tabs:h-full"
      >
        {TAB_ORDER.filter((t) => on[t]).map((t) => {
          switch (t) {
            case "changes":
              return (
                <Trigger key={t} tab={t} name="Changes" icon={<FileDiffIcon />}>
                  {s.changes > 0 && <span className={count}>{s.changes}</span>}
                </Trigger>
              );
            case "files":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Files"
                  icon={<FolderGit2Icon />}
                />
              );
            case "terminal":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Terminal"
                  icon={<SquareTerminalIcon />}
                >
                  {s.termRunning && (
                    <CircleDotIcon className="size-3 animate-pulse text-work" />
                  )}
                </Trigger>
              );
            case "preview":
              return (
                <Trigger key={t} tab={t} name="Preview" icon={<GlobeIcon />} />
              );
            case "pr":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name={prName}
                  data-wb-empty={pr == null || undefined}
                  className={pr == null ? "opacity-40" : undefined}
                  icon={
                    <GitPullRequestIcon
                      className={
                        pr?.status === "merged"
                          ? "text-violet-600"
                          : pr?.status === "closed"
                            ? "text-zinc-500"
                            : "text-emerald-600"
                      }
                    />
                  }
                />
              );
            case "background":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Background"
                  data-wb-empty={s.jobs === 0 || undefined}
                  className={s.jobs === 0 ? "opacity-40" : undefined}
                  icon={<CpuIcon />}
                >
                  {s.jobsRunning > 0 && (
                    <span
                      className="flex items-center gap-1 text-emerald-600 tabular-nums"
                      data-bg-running={s.jobsRunning}
                    >
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                      {s.jobsRunning}
                    </span>
                  )}
                </Trigger>
              );
            case "plan":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Plan"
                  data-wb-empty={plan == null || undefined}
                  className={plan == null ? "opacity-40" : undefined}
                  icon={<ListChecksIcon />}
                >
                  {plan?.status === "proposed" ? (
                    <span className="size-1.5 animate-pulse rounded-full bg-work" />
                  ) : (
                    plan?.status === "approved" && (
                      <span className={count}>
                        {
                          plan.steps.filter((x) => x.status === "completed")
                            .length
                        }
                        /{plan.steps.length}
                      </span>
                    )
                  )}
                </Trigger>
              );
            case "subagents":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Subagents"
                  data-wb-empty={s.helpers === 0 || undefined}
                  className={s.helpers === 0 ? "opacity-40" : undefined}
                  icon={<NetworkIcon />}
                >
                  {s.helpersRunning > 0 && (
                    <span
                      className="flex items-center gap-1 text-work tabular-nums"
                      data-subagents-running={s.helpersRunning}
                    >
                      <span className="size-1.5 animate-pulse rounded-full bg-work" />
                      {s.helpersRunning}
                    </span>
                  )}
                </Trigger>
              );
            case "browser":
              return (
                <Trigger
                  key={t}
                  tab={t}
                  name="Browser"
                  data-wb-browser
                  icon={<GlobeIcon />}
                />
              );
            case "details":
              return (
                <Trigger key={t} tab={t} name="Details" icon={<InfoIcon />} />
              );
            default:
              return null;
          }
        })}
      </TabsList>
      {revalidating && (
        <span
          data-wb-revalidating
          className="shrink-0 pl-2 text-[12px] text-muted-foreground/70"
        >
          updating…
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        title="Hide workbench"
        aria-label="Hide workbench"
        className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4"
      >
        <PanelRightCloseIcon />
      </button>
    </div>
  );
}
