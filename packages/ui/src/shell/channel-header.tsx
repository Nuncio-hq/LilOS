import { HashIcon, MenuIcon, PanelRightIcon, TicketIcon } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { Channel, Employee } from "../types";
import { HermesAvatar } from "./avatars";

/* Channel header + the employee chip strip under it. */
export function ChannelHeader({
  channel,
  projectName,
  employees,
  onNav,
  onOpenTickets,
  panelOpen,
  onOpenPanel,
  onShowEmp,
}: {
  channel: Channel;
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onNav}
        >
          <MenuIcon />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-muted-foreground text-xs">
            Oscar Co / {projectName ?? "Company"}
          </div>
          <div className="flex items-center gap-1 font-semibold text-base">
            <HashIcon className="size-4 shrink-0" />
            <span className="truncate">{channel.name}</span>
          </div>
        </div>
        {channel.repo ? (
          <Badge
            variant="outline"
            className="hidden shrink-0 font-mono md:inline-flex"
          >
            ⎇ {channel.repo}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="hidden shrink-0 text-muted-foreground md:inline-flex"
          >
            office work
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={onOpenTickets}>
            <TicketIcon />
            <span className="hidden sm:inline">Tickets</span>
          </Button>
          {!panelOpen && (
            <Button variant="ghost" size="icon-sm" onClick={onOpenPanel}>
              <PanelRightIcon />
            </Button>
          )}
        </div>
      </header>

      {channel.employees.length > 0 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2 sm:px-5">
          {channel.employees.map((id) => {
            const e = employees.find((x) => x.id === id);
            if (!e) return null;
            return (
              <button
                key={id}
                onClick={() => onShowEmp(id)}
                className="flex shrink-0 items-center gap-2 rounded-full border bg-background py-1 pr-3 pl-1 text-xs hover:border-foreground/30"
              >
                <HermesAvatar
                  name={e.name}
                  status={e.status}
                  className="size-6"
                />
                <span className="font-medium">{e.name}</span>
                <span className="hidden max-w-48 truncate text-muted-foreground sm:inline">
                  {e.now}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
