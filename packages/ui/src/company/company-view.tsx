import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { CeoChat } from "./ceo-chat";
import type {
  Bot,
  BotAsk,
  CeoInfo,
  CeoTurn,
  CompanyGoal,
  CompanyProject,
  CompanyTicket,
} from "./company-types";
import { TicketBoard } from "./ticket-board";
import { TicketDetail } from "./ticket-detail";
import { WorkforcePanel } from "./workforce-panel";

/* The AI company (#746): the owner talks to one CEO; the CEO hands tickets to
   always-on bots (Grok Bot, Muse…) and checks their work. Three columns:
   CEO chat · work (goals + tickets) · needs-you + bot teams. Props in,
   callbacks out; the prototype owns the mock data. */
export function CompanyView({
  ceo,
  turns,
  projects,
  goals,
  tickets,
  bots,
  asks,
  onSendToCeo,
  onApprove,
  onDeny,
  onNav,
}: {
  ceo: CeoInfo;
  turns: CeoTurn[];
  projects: CompanyProject[];
  goals: CompanyGoal[];
  tickets: CompanyTicket[];
  bots: Bot[];
  asks: BotAsk[];
  onSendToCeo?: (text: string) => void;
  onApprove?: (askId: string) => void;
  onDeny?: (askId: string) => void;
  onNav?: () => void;
}) {
  const [projectId, setProjectId] = useState<string | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const ticket = open ? tickets.find((t) => t.id === open) : undefined;

  /* ≥2xl: three columns. lg–2xl: CEO full height on the left; Work above
     Workforce on the right (each scrolls on its own). <lg: one stacked,
     scrolling column. */
  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-[10px] max-lg:overflow-y-auto lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,3fr)_minmax(0,2fr)] 2xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)_340px] 2xl:grid-rows-1">
      {onNav && (
        <div className="lilos-glass col-span-full flex items-center gap-2 px-3 py-2 lg:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNav}
            aria-label="Open navigation"
          >
            <MenuIcon />
          </Button>
          <span className="font-semibold">Company</span>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-col max-lg:h-[70vh] lg:row-span-2 2xl:row-span-1 [&>section]:flex-1">
        <CeoChat
          ceo={ceo}
          turns={turns}
          tickets={tickets}
          onSend={onSendToCeo}
          onOpenTicket={setOpen}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-[10px] [&>section]:flex-1">
        {ticket && (
          <TicketDetail
            ticket={ticket}
            bot={bots.find((b) => b.id === ticket.assignee)}
            asks={asks.filter((a) => a.ticketId === ticket.id)}
            onClose={() => setOpen(null)}
          />
        )}
        <TicketBoard
          projects={projects}
          projectId={projectId}
          onProject={setProjectId}
          goals={goals}
          tickets={tickets}
          bots={bots}
          selected={open}
          onOpenTicket={setOpen}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col [&>aside]:flex-1">
        <WorkforcePanel
          projects={projects}
          bots={bots}
          asks={asks}
          tickets={tickets}
          onApprove={onApprove}
          onDeny={onDeny}
          onOpenTicket={setOpen}
        />
      </div>
    </div>
  );
}
