import { HashIcon, MenuIcon, PanelRightIcon, TicketIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import type { Channel, Employee } from "../types";
import { HermesAvatar } from "./avatars";

/* Channel header + the employee chip strip under it. */
export function ChannelHeader({
  channel,
  companyName,
  projectName,
  employees,
  onNav,
  onOpenTickets,
  panelOpen,
  onOpenPanel,
  onShowEmp,
}: {
  channel: Channel;
  /** The user's company — the breadcrumb's left half (#118). */
  companyName: string;
  projectName?: string;
  employees: Employee[];
  onNav: () => void;
  onOpenTickets: () => void;
  panelOpen: boolean;
  onOpenPanel: () => void;
  onShowEmp: (id: string) => void;
}) {
  return (
    <>
      <header className="lilos-drag flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onNav}
        >
          <MenuIcon />
        </Button>
        <div className="min-w-0">
          <div
            className="flex items-center gap-1 font-semibold text-[17px] tracking-tight"
            title={`${companyName} / ${projectName ?? "Company"}${channel.repo ? ` · ${channel.repo}` : ""}`}
          >
            <HashIcon className="size-4 shrink-0" />
            <span className="truncate">{channel.name}</span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenTickets}
            title="Tickets"
            aria-label="Tickets"
          >
            <TicketIcon />
          </Button>
          {!panelOpen && (
            <Button variant="ghost" size="icon-sm" onClick={onOpenPanel}>
              <PanelRightIcon />
            </Button>
          )}
        </div>
      </header>

      {channel.employees.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b px-3 py-2 sm:px-5">
          {channel.employees.map((id) => {
            const e = employees.find((x) => x.id === id);
            if (!e) return null;
            return (
              <button
                key={id}
                onClick={() => onShowEmp(id)}
                title={e.now}
                className="lilos-lift flex shrink-0 items-center gap-2 rounded-full bg-accent py-1 pr-3 pl-1 text-xs hover:bg-foreground/10"
              >
                <HermesAvatar
                  name={e.name}
                  status={e.status}
                  className="size-6"
                />
                <span className="font-medium">{e.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
