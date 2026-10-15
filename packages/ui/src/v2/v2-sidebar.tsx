import {
  ChevronRightIcon,
  FolderPlusIcon,
  HandIcon,
  LayoutDashboardIcon,
  PenSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, StateDot } from "./v2-bits";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";

/* One sidebar row. Title leads; the agent is a small orb on the right so a
   column of rows reads as a list of tasks, not a list of people. Rows that
   came back to you are semibold; everything else is regular weight. */
function Row({
  t,
  agent,
  active,
  onOpen,
  indent,
}: {
  t: V2Thread;
  agent?: V2Agent;
  active: boolean;
  onOpen: () => void;
  indent?: boolean;
}) {
  const hot = V2_ATTENTION.includes(t.state);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-v2-thread={t.id}
      data-state={t.state}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2.5 rounded-lg pr-2 text-left text-[13px] transition-colors",
        indent ? "pl-7" : "pl-3",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/85 hover:bg-foreground/[0.04]",
      )}
    >
      <span className="grid w-2 place-items-center">
        {t.pinned && t.state === "idle" ? (
          <PinIcon className="size-2.5 text-muted-foreground" />
        ) : (
          <StateDot state={t.state} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          hot && "font-semibold text-foreground",
          t.state === "settled" && "text-muted-foreground",
        )}
      >
        {t.title}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover:hidden">
        {ago(t.ago)}
      </span>
      <HermesAvatar
        name={agent?.name}
        className="hidden size-4 shrink-0 group-hover:inline-block"
      />
    </button>
  );
}

function Fold({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 pl-3 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {label}
      </button>
      {open && children}
    </>
  );
}

function ProjectBlock({
  p,
  threads,
  agents,
  current,
  onOpen,
  onNew,
}: {
  p: V2Project;
  threads: V2Thread[];
  agents: V2Agent[];
  current: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [openWorking, setOpenWorking] = useState(false);
  const [settledShown, setSettledShown] = useState(0);
  const agent = (id: string) => agents.find((a) => a.id === id);
  const byAgo = (a: V2Thread, b: V2Thread) => a.ago - b.ago;
  const top = threads
    .filter(
      (t) =>
        t.pinned ||
        V2_ATTENTION.includes(t.state) ||
        (t.state === "idle" && t.ago < 3 * 1440),
    )
    .filter((t) => t.state !== "working" && t.state !== "settled")
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        Number(V2_ATTENTION.includes(b.state)) -
          Number(V2_ATTENTION.includes(a.state)) ||
        byAgo(a, b),
    );
  const working = threads.filter((t) => t.state === "working").sort(byAgo);
  const snoozed = threads.filter((t) => t.state === "snoozed");
  const settled = threads.filter((t) => t.state === "settled").sort(byAgo);
  const activeInWorking = working.some((t) => t.id === current);
  return (
    <section className="mt-5 first:mt-2" aria-label={p.name}>
      <div className="group flex h-7 items-center pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-medium text-[12px] text-muted-foreground">
          {p.name}
        </span>
        <button
          type="button"
          onClick={onNew}
          aria-label={`New thread in ${p.name}`}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {threads.length === 0 && (
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 w-full items-center gap-2.5 rounded-lg pl-3 text-[13px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
          New thread
        </button>
      )}
      {top.map((t) => (
        <Row
          key={t.id}
          t={t}
          agent={agent(t.agentId)}
          active={t.id === current}
          onOpen={() => onOpen(t.id)}
        />
      ))}
      {working.length > 0 && (
        <Fold
          label={`${working.length} working`}
          open={openWorking || activeInWorking}
          onToggle={() => setOpenWorking((o) => !o)}
        >
          {working.map((t) => (
            <Row
              key={t.id}
              t={t}
              agent={agent(t.agentId)}
              active={t.id === current}
              onOpen={() => onOpen(t.id)}
              indent
            />
          ))}
        </Fold>
      )}
      {(snoozed.length > 0 || settled.length > 0) && (
        <Fold
          label={[
            snoozed.length ? `${snoozed.length} snoozed` : "",
            settled.length ? `${settled.length} settled` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          open={settledShown > 0}
          onToggle={() => setSettledShown((n) => (n ? 0 : 12))}
        >
          {[...snoozed, ...settled.slice(0, settledShown)].map((t) => (
            <Row
              key={t.id}
              t={t}
              agent={agent(t.agentId)}
              active={t.id === current}
              onOpen={() => onOpen(t.id)}
              indent
            />
          ))}
          {settled.length > settledShown && (
            <button
              type="button"
              onClick={() => setSettledShown((n) => n + 25)}
              className="h-7 w-full pl-7 text-left text-[12px] text-muted-foreground hover:text-foreground"
            >
              Show more
            </button>
          )}
        </Fold>
      )}
    </section>
  );
}

/* The v2 sidebar: no channels, no DMs. Search and New at the top, one
   "Needs you" row, then projects. Each project lists only what came back to
   you and recent quiet threads; running threads fold into one line and old
   threads settle out of the list on their own. */
export type V2Page = "home" | "needs" | "agents" | "settings" | null;

function NavRow({
  icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/85 hover:bg-foreground/[0.04]",
      )}
    >
      <span className="grid w-3.5 place-items-center text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="flex-1 text-left font-medium">{label}</span>
      {trailing}
    </button>
  );
}

export function V2Sidebar({
  company,
  projects,
  threads,
  agents,
  current,
  page,
  onOpen,
  onNew,
  onPage,
  onSearch,
  onAddProject,
}: {
  company: string;
  projects: V2Project[];
  threads: V2Thread[];
  agents: V2Agent[];
  current: string | null;
  page: V2Page;
  onOpen: (id: string) => void;
  onNew: (projectId?: string) => void;
  onPage: (p: Exclude<V2Page, null>) => void;
  onSearch: () => void;
  onAddProject: () => void;
}) {
  const needs = threads.filter((t) => V2_ATTENTION.includes(t.state)).length;
  const working = threads.filter((t) => t.state === "working").length;
  return (
    <aside className="lilos-v2-side flex min-h-0 w-[272px] shrink-0 flex-col">
      <div className="lilos-drag flex h-[52px] shrink-0 items-center gap-2 pr-2 pl-4">
        <div className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-foreground font-semibold text-[10px] text-background">
          {company
            .split(/\s+/)
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <span className="min-w-0 flex-1 truncate font-semibold text-[13px]">
          {company}
        </span>
        <button
          type="button"
          onClick={() => onNew()}
          aria-label="New thread"
          title="New thread  ⌘N"
          className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <PenSquareIcon className="size-4" />
        </button>
      </div>
      <div className="px-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-8 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <SearchIcon className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-muted-foreground/80">
            ⌘K
          </kbd>
        </button>
        <NavRow
          icon={<LayoutDashboardIcon />}
          label="Home"
          active={page === "home"}
          onClick={() => onPage("home")}
          trailing={
            working > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                <StateDot state="working" />
                {working}
              </span>
            )
          }
        />
        <NavRow
          icon={
            <HandIcon
              className={cn(needs > 0 && "text-amber-500 dark:text-amber-400")}
            />
          }
          label="Needs you"
          active={page === "needs"}
          onClick={() => onPage("needs")}
          trailing={
            needs > 0 && (
              <span className="min-w-5 rounded-full bg-amber-500/15 px-1.5 text-center font-semibold text-[11px] text-amber-700 tabular-nums dark:text-amber-300">
                {needs}
              </span>
            )
          }
        />
        <NavRow
          icon={<UsersIcon />}
          label="Agents"
          active={page === "agents"}
          onClick={() => onPage("agents")}
        />
      </div>
      <nav
        aria-label="Projects"
        className="mt-3 min-h-0 flex-1 overflow-y-auto border-foreground/[0.06] border-t px-2 pb-4 [scrollbar-width:thin]"
      >
        <div className="flex h-9 items-center pr-1 pl-3">
          <span className="flex-1 font-semibold text-[11px] text-muted-foreground/80 uppercase tracking-[0.06em]">
            Projects
          </span>
          <button
            type="button"
            onClick={onAddProject}
            aria-label="Add project"
            title="Add project"
            data-v2-add-project
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <FolderPlusIcon className="size-3.5" />
          </button>
        </div>
        {projects.map((p) => {
          const mine = threads.filter((t) => t.projectId === p.id);
          if (mine.length === 0 && !p.path) return null;
          return (
            <ProjectBlock
              key={p.id}
              p={p}
              threads={mine}
              agents={agents}
              current={current}
              onOpen={onOpen}
              onNew={() => onNew(p.id)}
            />
          );
        })}
      </nav>
      <div className="flex h-12 shrink-0 items-center gap-1 border-foreground/[0.06] border-t px-2">
        <button
          type="button"
          aria-label="Settings"
          title="Settings  ⌘,"
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => onPage("settings")}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] hover:bg-foreground/[0.04] hover:text-foreground",
            page === "settings"
              ? "bg-foreground/[0.07] text-foreground"
              : "text-muted-foreground",
          )}
        >
          <SettingsIcon className="size-3.5" />
          Settings
        </button>
      </div>
    </aside>
  );
}
