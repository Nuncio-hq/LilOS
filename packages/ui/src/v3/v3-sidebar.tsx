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
import { agentDot, companyOn } from "./v3-model";
import type { V3PageRoute, V3RecordRoute, V3Route } from "./v3-page-types";
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
  onNewProject,
  mode,
  width,
  sideRef,
  onToggle,
  onPointerEnter,
  onPointerLeave,
  onBlur,
}: {
  data: V3Data;
  /** The page you are on: its entry stays lit while records open beside it. */
  page: V3PageRoute;
  /** The record in the side peek, if any: a project or person gets a mark. */
  open?: V3RecordRoute;
  go: (r: V3Route) => void;
  onSearch: () => void;
  dark: boolean;
  onTheme: () => void;
  /** The app can create agents; without it the Hire entry is not drawn. */
  canHire?: boolean;
  /** The app can make a project of a folder: the Projects label gets a +
     (#854). Absent: no +, the list stands alone. */
  onNewProject?: () => void;
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
  const live = data.threads.filter(
    (t) => t.status !== "done" && t.status !== "idle",
  ).length;
  const on = (p: V3Route["page"], id?: string) =>
    id === undefined ? page.page === p : opened?.page === p && opened.id === id;

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
        {data.features.tickets && (
          <Item
            icon={<TargetIcon />}
            label="Goals"
            on={on("goals")}
            onClick={() => go({ page: "goals" })}
            right={<Count n={data.goals.length} />}
          />
        )}

        {/* No projects yet (a company of plain folders): no empty heading —
            unless the + can make the first one (#854). */}
        {(data.projects.length > 0 || onNewProject) && (
          <>
            <div className="flex items-end">
              <Label>Projects</Label>
              {onNewProject && (
                <button
                  type="button"
                  onClick={onNewProject}
                  aria-label="New project from a folder"
                  title="New project from a folder"
                  data-new-project
                  className="mr-1 mb-[3px] ml-auto grid size-[22px] shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&>svg]:size-3.5"
                >
                  <PlusIcon />
                </button>
              )}
            </div>
            {data.projects.map((p) => (
              <Item
                key={p.id}
                icon={<ProjectMark name={p.name} tone={p.tone} />}
                label={p.name}
                on={on("project", p.id)}
                onClick={() => go({ page: "project", id: p.id })}
              />
            ))}
          </>
        )}

        {/* The roster is the company's team list: with the layer paused
            (D-#836) the agents still run underneath, they are just not a
            table of contents you browse. */}
        {companyOn(data) && (
          <>
            <Label onClick={() => go({ page: "people" })} on={on("people")}>
              People
            </Label>
            {data.agents.map((a) => (
              <Item
                key={a.id}
                icon={<AgentAvatar data={data} agent={a} />}
                label={a.name}
                on={on("agent", a.id)}
                onClick={() => go({ page: "agent", id: a.id })}
                right={
                  <>
                    {a.id === data.ceoId && <CeoMark />}
                    <StatusDot
                      status={agentDot(data, a.id)}
                      className="size-[7px]"
                    />
                  </>
                }
              />
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
}: {
  children: ReactNode;
  onClick?: () => void;
  on?: boolean;
  /** The company's own name heads the section that holds its work. */
  company?: boolean;
}) {
  const cls =
    "min-w-0 shrink-0 truncate px-2 pt-[18px] pb-1 text-left font-medium text-[12px] text-muted-foreground/70";
  return onClick ? (
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
}
