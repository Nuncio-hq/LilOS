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
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, CeoMark, Kbd, ProjectMark, StatusDot } from "./v3-bits";
import { agentStatus } from "./v3-model";
import type { V3Data, V3PageRoute, V3RecordRoute, V3Route } from "./v3-types";

/* The v3 sidebar is the company's table of contents: the three databases
   (Work, Threads, Goals), the projects, and the people, each person with the
   one status dot that says whether they need anything. */
export function V3Sidebar({
  data,
  page,
  open: opened,
  go,
  onSearch,
  dark,
  onTheme,
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
}) {
  const open = data.tickets.filter((t) => t.status !== "done").length;
  const live = data.threads.filter(
    (t) => t.status !== "done" && t.status !== "idle",
  ).length;
  const on = (p: V3Route["page"], id?: string) =>
    id === undefined ? page.page === p : opened?.page === p && opened.id === id;

  return (
    <aside className="flex w-[236px] shrink-0 flex-col overflow-y-auto border-[var(--v3-line)] border-r bg-[var(--v3-side)] px-2 py-3 text-[14px] text-muted-foreground">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-3 font-semibold text-[14.5px] text-foreground">
        <span className="grid size-[22px] place-items-center rounded-md bg-foreground text-[11.5px] text-background">
          {data.company.slice(0, 1)}
        </span>
        {data.company}
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
                status={agentStatus(data, a.id)}
                className="size-[7px]"
              />
            </>
          }
        />
      ))}

      <div className="flex-1" />
      <Item
        icon={<PlusIcon />}
        label="Hire an agent"
        on={on("hire")}
        onClick={() => go({ page: "hire" })}
      />
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
