import {
  BookOpenIcon,
  CircleAlertIcon,
  EllipsisIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareCheckIcon,
  SunIcon,
  TargetIcon,
} from "lucide-react";
import {
  type PointerEventHandler,
  type ReactNode,
  type Ref,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Kbd } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { useMenu } from "./v3-keys";
import { AgentAvatar, CeoMark, ProjectMark, StatusDot } from "./v3-marks";
import { agentDot, boardStatus, companyOn, listedThreads } from "./v3-model";
import { isRecordRoute } from "./v3-nav";
import type { V3RecordRoute, V3Route } from "./v3-page-types";
import { type SidebarMode, SidebarToggle } from "./v3-topbar";
import type { V3Project, V3Status } from "./v3-types";

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
  onRenameProject,
  onStatus,
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
  /** The ＋ beside Projects makes one (the same ask-for-folder the project
     menu's row runs, D-#868). Absent: no ＋. */
  onNewProject?: () => void;
  /** A project row's ⋯ → Rename writes through this. Absent: no menu. */
  onRenameProject?: (projectId: string, name: string) => void;
  /** The engine footer's dot opens the app's status details. Absent: the
     row just reads the state. */
  onStatus?: () => void;
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

        {/* No projects yet (a company of plain folders): no empty heading.
            Notion-style (D-#868): the ＋ and each row's ⋯ show on hover. */}
        {data.projects.length > 0 && (
          <>
            <Label
              right={
                onNewProject && (
                  <button
                    type="button"
                    aria-label="New project"
                    title="New project"
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
                onClick={() => go({ page: "project", id: p.id })}
                onRename={onRenameProject}
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
            label="Hire an agent"
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
        {/* The engine's state as a quiet footer dot instead of a banner
            (D-#868): green while it runs, its reason on hover, Details on
            click where the app has them. */}
        <EngineFoot data={data} onStatus={onStatus} />
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
    <div className="group flex items-end pr-1">
      {head}
      {/* Hover-only, the Notion way (D-#868): still focusable and still a
          real button — opacity never takes it out of the a11y tree. */}
      <span className="ml-auto pb-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {right}
      </span>
    </div>
  );
}

/** One project row: its mark and name, a ⋯ on hover that opens the row's
   small menu — Rename swaps the name for a box in place (D-#868). */
function ProjectItem({
  project,
  on,
  onClick,
  onRename,
}: {
  project: V3Project;
  on?: boolean;
  onClick: () => void;
  onRename?: (projectId: string, name: string) => void;
}) {
  const menu = useMenu();
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <input
        aria-label="Project name"
        defaultValue={project.name}
        // biome-ignore lint/a11y/noAutofocus: it opens because you asked to rename
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onRename?.(project.id, e.currentTarget.value);
            setRenaming(false);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setRenaming(false);
          }
        }}
        onBlur={(e) => {
          onRename?.(project.id, e.currentTarget.value);
          setRenaming(false);
        }}
        className="mx-2 h-[30px] w-[calc(100%-16px)] rounded-md border border-foreground/20 bg-background px-1.5 text-[14px] text-foreground outline-none focus:border-foreground/40"
      />
    );
  }
  return (
    <span className="group relative">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-[30px] w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2 text-left transition-colors hover:bg-[var(--v3-hover)] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:opacity-70",
          on && "bg-[var(--v3-hover)] font-medium text-foreground",
        )}
      >
        <ProjectMark name={project.name} tone={project.tone} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </button>
      {onRename && (
        <>
          <button
            ref={menu.trigger}
            type="button"
            aria-label={`${project.name} actions`}
            title={`${project.name} actions`}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={() => menu.setOpen((o) => !o)}
            className={cn(
              "absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-[var(--v3-hover)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
              menu.open && "opacity-100",
            )}
          >
            <EllipsisIcon className="size-3.5" />
          </button>
          {menu.open && (
            <div
              ref={menu.list}
              role="menu"
              aria-label={`${project.name} actions`}
              onKeyDown={menu.onKeyDown}
              className="absolute top-[calc(100%-4px)] right-2 z-20 w-40 rounded-lg border bg-popover p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  menu.setOpen(false);
                  setRenaming(true);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-[var(--v3-hover)]"
              >
                <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">Rename</span>
              </button>
            </div>
          )}
        </>
      )}
    </span>
  );
}

/* The engine footer dot's word for each state: a green "running" while it
   is fine, the plain state otherwise. Relay beats engine: nothing reaches
   a fine engine through a dead link. */
const ENGINE_WORD: Record<string, { status: V3Status; word: string }> = {
  ok: { status: "done", word: "running" },
  starting: { status: "working", word: "starting" },
  old: { status: "needs", word: "needs an update" },
  missing: { status: "failed", word: "not installed" },
  down: { status: "failed", word: "down" },
};

function EngineFoot({
  data,
  onStatus,
}: {
  data: V3Data;
  onStatus?: () => void;
}) {
  const { engine, relay } = data.settings;
  const s: { status: V3Status; label: string; title?: string } =
    relay.state !== "ok"
      ? {
          status: relay.state === "down" ? "failed" : "working",
          label: `Relay ${relay.state}`,
          title: relay.problem,
        }
      : {
          status: ENGINE_WORD[engine.state]?.status ?? "idle",
          label: `${engine.name}${engine.version ? ` ${engine.version}` : ""} ${ENGINE_WORD[engine.state]?.word ?? engine.state}`,
          title: engine.problem,
        };
  return (
    <button
      type="button"
      onClick={onStatus}
      disabled={!onStatus}
      title={s.title ?? s.label}
      className={cn(
        "mt-1.5 flex h-7 w-full shrink-0 items-center gap-2 rounded-md border-[var(--v3-line)] border-t px-2 pt-1.5 text-left text-[12.5px] text-muted-foreground/80",
        onStatus && "hover:bg-[var(--v3-hover)] hover:text-foreground",
      )}
    >
      <StatusDot status={s.status} />
      <span className="min-w-0 flex-1 truncate" data-engine-foot>
        {s.label}
      </span>
    </button>
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
