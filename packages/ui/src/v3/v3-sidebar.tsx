import {
  BookOpenIcon,
  CircleAlertIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
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
import { agentDot } from "./v3-model";
import type { V3PageRoute, V3RecordRoute, V3Route } from "./v3-page-types";

/** Where the sidebar is: docked beside the page, hidden (out of the way,
    unreachable), or popped out over the page from its hidden state. */
export type SidebarMode = "docked" | "hidden" | "popped";

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
    // inert and invisible, popped out it floats over the page. It stays the
    // shell's first child: the desktop chrome keys on it (index.css).
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
        "flex shrink-0 flex-col overflow-y-auto border-[var(--v3-line)] border-r bg-[var(--v3-side)] px-2 py-3 text-[14px] text-muted-foreground",
        mode === "docked"
          ? "relative"
          : "absolute inset-y-0 left-0 z-40 transition-[translate,visibility] duration-150 ease-out motion-reduce:transition-none",
        mode === "hidden" && "invisible -translate-x-full",
      )}
    >
      <div className="lilos-drag flex items-center gap-2.5 px-2 pt-1 pb-3 font-semibold text-[14.5px] text-foreground">
        <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-foreground text-[11.5px] text-background">
          {data.company.slice(0, 1)}
        </span>
        <span className="min-w-0 truncate">{data.company}</span>
        <button
          type="button"
          onClick={onToggle}
          title={
            mode === "docked" ? "Hide sidebar (⌘\\)" : "Keep sidebar open (⌘\\)"
          }
          aria-label={mode === "docked" ? "Hide sidebar" : "Keep sidebar open"}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md font-normal text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4"
        >
          {mode === "docked" ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
        </button>
      </div>
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
      {/* Inbox, Work and Goals come with tickets (M2): hidden, not empty. */}
      {data.features.tickets && (
        <Item
          icon={<InboxIcon />}
          label="Inbox"
          on={on("inbox")}
          onClick={() => go({ page: "inbox" })}
        />
      )}

      <Label>Company</Label>
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

      {/* No projects yet (a company of plain folders): no empty heading. */}
      {data.projects.length > 0 && (
        <>
          <Label>Projects</Label>
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
              <StatusDot status={agentDot(data, a.id)} className="size-[7px]" />
            </>
          }
        />
      ))}

      <div className="flex-1" />
      {canHire && (
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
}: {
  children: ReactNode;
  onClick?: () => void;
  on?: boolean;
}) {
  const cls =
    "px-2 pt-[18px] pb-1 text-left font-medium text-[12px] text-muted-foreground/70";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "hover:text-foreground", on && "text-foreground")}
    >
      {children}
    </button>
  ) : (
    <div className={cls}>{children}</div>
  );
}
