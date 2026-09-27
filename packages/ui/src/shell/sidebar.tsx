import {
  BellIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  InboxIcon,
  ShieldAlertIcon,
  TicketIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { ChannelItem, NavItem, Section } from "../sidebar/nav";
import type {
  Channel,
  EmpBadge,
  Employee,
  Human,
  Project,
  StatusComponent,
  Theme,
} from "../types";
import { HermesAvatar, HumanAvatar } from "./avatars";
import { StatusRow } from "./status";
import { ThemeToggle } from "./theme-toggle";

/* The company sidebar: nav, company channels, projects (with folders + channels), employees, me-row.
   All data (company channels, projects, folders, employees) comes in as props. */
export function Sidebar({
  navOpen,
  hiddenWhenClosed,
  me,
  companyChannels,
  projects,
  folders,
  employees,
  view,
  theme,
  isProjectDefaultOpen,
  onSetTheme,
  onCloseNav,
  onGoChannel,
  onGoDM,
  onOpenTickets,
  onAddFolder,
  onHire,
  badges,
  status,
  onOpenStatus,
  realApp,
  preview,
}: {
  navOpen: boolean;
  hiddenWhenClosed: boolean;
  /* The signed-in human — the footer renders the same avatar + name the
     app's `human` lookup puts on that person's messages (issue #80, AC-1). */
  me: Human;
  companyChannels: Channel[];
  projects: Project[];
  folders: import("../types").Folder[];
  employees: Employee[];
  view: { kind: "channel" | "dm"; id: string };
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  isProjectDefaultOpen: (p: Project) => boolean;
  onCloseNav: () => void;
  onGoChannel: (id: string) => void;
  onGoDM: (id: string) => void;
  onOpenTickets: () => void;
  onAddFolder: () => void;
  /* Hiring lands in its own slice — omit the handler, hide the affordance. */
  onHire?: () => void;
  /* Per-employee counts: running turns / turns waiting on Oscar's approval. */
  badges?: Record<string, EmpBadge>;
  /* The status surface — a control renders only when its handler is passed. */
  status?: StatusComponent[];
  onOpenStatus?: () => void;
  /* realApp = what the shipped app sidebar will show today: Employees + status only. */
  realApp?: boolean;
  /* Prototype-only slot (e.g. the Preview states menu); omitted in production wiring. */
  preview?: React.ReactNode;
}) {
  return (
    <aside
      className={cn(
        "min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground",
        navOpen
          ? "fixed inset-y-0 left-0 z-40 flex w-[264px] shadow-2xl"
          : hiddenWhenClosed
            ? "hidden"
            : "hidden lg:flex",
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <div className="grid size-7 place-items-center rounded-md bg-foreground font-bold text-background text-xs">
          OC
        </div>
        <div className="font-semibold">Oscar Co</div>
        {!realApp && (
          <Button variant="ghost" size="icon-sm" className="ml-auto">
            <BellIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("lg:hidden", realApp && "ml-auto")}
          onClick={onCloseNav}
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {!realApp && (
          <>
            <nav className="space-y-0.5 p-2">
              <NavItem icon={<InboxIcon />} label="Inbox" />
              <NavItem
                icon={<ShieldAlertIcon />}
                label="Needs you"
                count={2}
                tone="amber"
              />
              <NavItem
                icon={<TicketIcon />}
                label="Tickets"
                onClick={onOpenTickets}
              />
            </nav>

            <Section title="Company" />
            <div className="px-2">
              {companyChannels.map((c) => (
                <ChannelItem
                  key={c.id}
                  c={c}
                  active={view.kind === "channel" && c.id === view.id}
                  onClick={() => onGoChannel(c.id)}
                />
              ))}
            </div>

            <Section title="Projects" onAdd={onAddFolder} />
            <div className="space-y-1 px-2">
              {projects.map((p) => (
                <Collapsible key={p.id} defaultOpen={isProjectDefaultOpen(p)}>
                  <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-medium hover:bg-sidebar-accent">
                    <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                    <FolderGit2Icon className="size-4 text-muted-foreground" />
                    {p.name}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {p.key}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="ml-4 border-l pl-2">
                    {folders
                      .filter((f) => f.project === p.name)
                      .map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground text-xs"
                          title={f.path}
                          data-sidebar-folder
                        >
                          <FolderIcon className="size-3.5 shrink-0" />
                          <span className="truncate font-mono">
                            {f.path.replace(/^~\/Desktop\/Oscar\//, "…/")}
                          </span>
                        </div>
                      ))}
                    {p.channels.map((c) => (
                      <ChannelItem
                        key={c.id}
                        c={c}
                        active={view.kind === "channel" && c.id === view.id}
                        onClick={() => onGoChannel(c.id)}
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </>
        )}

        <Section title="Employees" onAdd={onHire} />
        <div className="px-2 pb-4">
          {employees.map((e) => {
            const b = badges?.[e.id];
            return (
              <button
                key={e.id}
                onClick={() => onGoDM(e.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent",
                  view.kind === "dm" &&
                    view.id === e.id &&
                    "bg-sidebar-accent font-medium",
                )}
              >
                <HermesAvatar
                  name={e.name}
                  status={e.status}
                  className="size-5"
                />
                <span className="min-w-0 truncate">{e.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {!!b?.approvals && (
                    <span
                      data-badge-approvals
                      title={`${b.approvals} waiting on your approval`}
                      className="rounded-full bg-amber-500 px-1.5 text-[11px] text-white"
                    >
                      {b.approvals === 1
                        ? "needs you"
                        : `${b.approvals} need you`}
                    </span>
                  )}
                  {!!b?.running && (
                    <span
                      data-badge-running
                      title={`${b.running} running`}
                      className="rounded-full bg-blue-600 px-1.5 text-[11px] text-white"
                    >
                      {b.running}
                    </span>
                  )}
                  <span className="text-muted-foreground text-xs">
                    {e.role}
                  </span>
                </span>
              </button>
            );
          })}
          {onHire && (
            <button
              onClick={onHire}
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <UserPlusIcon className="size-4" /> Hire employee
            </button>
          )}
        </div>
      </ScrollArea>
      {status && onOpenStatus && (
        <StatusRow components={status} onOpen={onOpenStatus} />
      )}
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2.5">
        <HumanAvatar human={me} size="sm" className="rounded-full" />
        <span className="min-w-0 truncate font-medium text-sm">{me.name}</span>
        {preview}
        <ThemeToggle theme={theme} setTheme={onSetTheme} />
      </div>
    </aside>
  );
}
