import {
  BookOpenIcon,
  CircleAlertIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareCheckIcon,
  SunIcon,
  TargetIcon,
} from "lucide-react";
import type { PointerEventHandler, ReactNode, Ref } from "react";
import { cn } from "../lib/utils";
import { Kbd } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar, CeoMark, ProjectMark, StatusDot } from "./v3-marks";
import { agentDot, boardStatus, companyOn, listedThreads } from "./v3-model";
import { isRecordRoute } from "./v3-nav";
import type { V3RecordRoute, V3Route } from "./v3-page-types";
import { ProjectMenu } from "./v3-project-menu";
import { type SidebarMode, SidebarToggle } from "./v3-topbar";

/* The v3 sidebar is the company's table of contents: the three databases
   (Work, Threads, Goals), the projects, and the people, each person with the
   one status dot that says what wants your eye (needs you, working, failed,
   finished and not seen yet). */
export function V3Sidebar({
  data,
  page,
  open: opened,
  go,
  onSearch,
  dark,
  onTheme,
  canHire = true,
  onAddAgent,
  onNewProject,
  onRemoveProject,
  mode,
  width,
  sideRef,
  onToggle,
  onPointerEnter,
  onPointerLeave,
  onBlur,
}: {
  data: V3Data;
  /** Where you are — a page, or the record you went straight to (D-#769):
     a project or agent the sidebar navigated to keeps its entry lit. */
  page: V3Route;
  /** The record in the side peek, if any: a project or person gets a mark. */
  open?: V3RecordRoute;
  go: (r: V3Route) => void;
  onSearch: () => void;
  dark: boolean;
  onTheme: () => void;
  /** The app can create agents; without it the Hire entry is not drawn. */
  canHire?: boolean;
  /** Opens the add-agent dialog (#870); drawn as the ＋ beside Agents while
     the company layer is paused. Absent = the app cannot create agents. */
  onAddAgent?: () => void;
  /** Opens the folder picker for a new project (#854) — the ＋ beside
     Projects; the heading stays even while there are none. Absent = the
     app cannot create projects. */
  onNewProject?: () => void;
  /** A project row's ⋯ → Remove project (#854). Absent = rows carry no
     menu (the app cannot remove projects). */
  onRemoveProject?: (projectId: string) => void | Promise<void>;
  mode: SidebarMode;
  width: number;
  sideRef: Ref<HTMLElement>;
  /** Docks a popped-out sidebar, or hides a docked one. */
  onToggle: () => void;
  onPointerEnter: PointerEventHandler;
  onPointerLeave: PointerEventHandler;
  onBlur: () => void;
}) {
  const open = data.tickets.filter((t) => t.status !== "done").length;
  /* The badge counts threads in play, not the board — a finished-unseen
     thread stays on the board (D-#563) but does not badge. Helpers have no
     row (D-#847); a parent waiting on them counts as working. */
  const live = listedThreads(data.threads).filter((t) => {
    const s = boardStatus(data, t);
    return s !== "done" && s !== "idle";
  }).length;
  /* A bare page lights its own entry; a record lights it when it IS the
     page (the sidebar went to it) or sits on top of the peek. */
  const on = (p: V3Route["page"], id?: string) =>
    id === undefined
      ? page.page === p
      : (isRecordRoute(page) && page.page === p && page.id === id) ||
        (opened?.page === p && opened.id === id);

  return (
    // Always mounted, so hiding keeps its scroll and its place; hidden, it is
    // inert and invisible, popped out it floats over the page — over the
    // toolbar row too, so its own top row clears the traffic lights.
    <aside
      ref={sideRef}
      data-sidebar={mode}
      inert={mode === "hidden"}
      style={{ width }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onBlur();
      }}
      className={cn(
        "flex shrink-0 flex-col border-[var(--v3-line)] border-r bg-[var(--v3-side)] text-[14px] text-muted-foreground",
        mode === "docked"
          ? "relative"
          : "absolute inset-y-0 left-0 z-40 transition-[translate,visibility] duration-150 ease-out motion-reduce:transition-none",
        mode === "hidden" && "invisible -translate-x-full",
      )}
    >
      {/* The sidebar's segment of the toolbar row (D-#232, #797): the lights,
        then the toggle. The list scrolls below it, never under the lights. */}
      <div
        data-toolbar
        data-toolbar-lead
        className="lilos-drag flex h-[var(--v3-toolbar-h)] shrink-0 items-center px-3.5"
      >
        <SidebarToggle mode={mode} onToggle={onToggle} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <Item
          icon={<SearchIcon />}
          label="Search"
          onClick={onSearch}
          right={<Kbd>⌘K</Kbd>}
        />
        <Item
          icon={<HomeIcon />}
          label="Home"
          on={on("home")}
          onClick={() => go({ page: "home" })}
        />
        <Item
          icon={<CircleAlertIcon />}
          label="Needs you"
          on={on("needs")}
          onClick={() => go({ page: "needs" })}
          right={
            data.asks.length > 0 && (
              <span className="font-semibold text-[12px] text-orange-600 dark:text-orange-400">
                {data.asks.length}
              </span>
            )
          }
        />
        {/* Inbox, Work and Goals come with tickets (M2). Inbox stays hidden
            until it has updates — an empty inbox is not a place to open. */}
        {data.features.tickets && data.updates.length > 0 && (
          <Item
            icon={<InboxIcon />}
            label="Inbox"
            on={on("inbox")}
            onClick={() => go({ page: "inbox" })}
          />
        )}

        {/* The company name heads the work section — a paused company layer
            (D-#836) has neither the name nor the Work and Goals under it. */}
        {companyOn(data) && <Label company>{data.company}</Label>}
        {data.features.tickets && (
          <Item
            icon={<SquareCheckIcon />}
            label="Work"
            on={on("work")}
            onClick={() => go({ page: "work" })}
            right={<Count n={open} />}
          />
        )}
        <Item
          icon={<LayersIcon />}
          label="Threads"
          on={on("threads")}
          onClick={() => go({ page: "threads" })}
          right={<Count n={live} />}
        />
        {/* No thread list here (#862 feedback): the sidebar stays the
            table of contents — the sectioned list lives on the Threads
            page only. */}
        {data.features.tickets && (
          <Item
            icon={<TargetIcon />}
            label="Goals"
            on={on("goals")}
            onClick={() => go({ page: "goals" })}
            right={<Count n={data.goals.length} />}
          />
        )}

        {/* Projects are the owner's by hand (D-#854): the heading and its ＋
            show even with none, so the way in is never hidden. */}
        {(data.projects.length > 0 || onNewProject) && (
          <>
            <Label
              right={
                onNewProject && (
                  <button
                    type="button"
                    aria-label="New project from a folder"
                    title="New project from a folder"
                    data-new-project
                    onClick={onNewProject}
                    className="grid size-5 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                )
              }
            >
              Projects
            </Label>
            {data.projects.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                on={on("project", p.id)}
                go={go}
                onRemove={
                  onRemoveProject ? () => onRemoveProject(p.id) : undefined
                }
              />
            ))}
          </>
        )}

        {/* The roster is the company's team list: with the layer paused
            (D-#836) the agents still run underneath — as the Agents section,
            a flat list with a ＋ to add one in seconds (#870), not a page
            you browse to. */}
        {companyOn(data) ? (
          <>
            <Label onClick={() => go({ page: "people" })} on={on("people")}>
              People
            </Label>
            {data.agents.map((a) => (
              <AgentItem key={a.id} data={data} agent={a} on={on} go={go} />
            ))}
          </>
        ) : (
          <>
            <Label
              right={
                onAddAgent && (
                  <button
                    type="button"
                    aria-label="Add agent"
                    title="Add agent"
                    onClick={onAddAgent}
                    className="grid size-5 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                )
              }
            >
              Agents
            </Label>
            {data.agents.map((a) => (
              <AgentItem key={a.id} data={data} agent={a} on={on} go={go} />
            ))}
          </>
        )}

        <div className="flex-1" />
        {canHire && companyOn(data) && (
          <Item
            icon={<PlusIcon />}
            label="Add an agent"
            on={on("hire")}
            onClick={() => go({ page: "hire" })}
          />
        )}
        <Item
          icon={<BookOpenIcon />}
          label="How it works"
          on={on("guide")}
          onClick={() => go({ page: "guide" })}
        />
        <Item
          icon={<SettingsIcon />}
          label="Settings"
          on={on("settings")}
          onClick={() => go({ page: "settings" })}
        />
        <Item
          icon={dark ? <SunIcon /> : <MoonIcon />}
          label={dark ? "Light mode" : "Dark mode"}
          onClick={onTheme}
        />
      </div>
    </aside>
  );
}

function Item({
  icon,
  label,
  on,
  onClick,
  right,
}: {
  icon: ReactNode;
  label: string;
  on?: boolean;
  onClick: () => void;
  right?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-[30px] w-full shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2 text-left transition-colors hover:bg-[var(--v3-hover)] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:opacity-70",
        on && "bg-[var(--v3-hover)] font-medium text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-[12px] text-muted-foreground/70">{n}</span>;
}

/** A project row: the project it opens plus its ⋯ menu (D-#854). The row
    is a div — a button cannot hold the menu's own button — with the Item's
    look split across the two. */
function ProjectItem({
  project,
  on,
  go,
  onRemove,
}: {
  project: V3Data["projects"][number];
  on: boolean;
  go: (r: V3Route) => void;
  onRemove?: () => void | Promise<void>;
}) {
  return (
    <div
      className={cn(
        "flex h-[30px] shrink-0 items-center rounded-md pr-1 transition-colors hover:bg-[var(--v3-hover)]",
        on && "bg-[var(--v3-hover)] font-medium text-foreground",
      )}
    >
      <button
        type="button"
        onClick={() => go({ page: "project", id: project.id })}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 whitespace-nowrap px-2 pr-1 text-left [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:opacity-70"
      >
        <ProjectMark name={project.name} tone={project.tone} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </button>
      <ProjectMenu name={project.name} onRemove={onRemove} />
    </div>
  );
}

function Label({
  children,
  onClick,
  on,
  company,
  right,
}: {
  children: ReactNode;
  onClick?: () => void;
  on?: boolean;
  /** The company's own name heads the section that holds its work. */
  company?: boolean;
  /** A quiet control at the row's right (the Agents section's ＋). */
  right?: ReactNode;
}) {
  const cls =
    "min-w-0 shrink-0 truncate px-2 pt-[18px] pb-1 text-left font-medium text-[12px] text-muted-foreground/70";
  const head = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "hover:text-foreground", on && "text-foreground")}
    >
      {children}
    </button>
  ) : (
    <div data-company-label={company || undefined} className={cls}>
      {children}
    </div>
  );
  if (!right) return head;
  return (
    <div className="flex items-end pr-1">
      {head}
      <span className="ml-auto pb-1">{right}</span>
    </div>
  );
}

/** One roster row — the People section's and the paused Agents section's
   share it (avatar, name, CEO mark and the one status dot). */
function AgentItem({
  data,
  agent,
  on,
  go,
}: {
  data: V3Data;
  agent: V3Data["agents"][number];
  on: (p: V3Route["page"], id?: string) => boolean;
  go: (r: V3Route) => void;
}) {
  return (
    <Item
      icon={<AgentAvatar data={data} agent={agent} />}
      label={agent.name}
      on={on("agent", agent.id)}
      onClick={() => go({ page: "agent", id: agent.id })}
      right={
        <>
          {agent.id === data.ceoId && <CeoMark />}
          <StatusDot status={agentDot(data, agent.id)} className="size-[7px]" />
        </>
      }
    />
  );
}
