import { XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { BotAvatar, ProviderChip, TicketStatePill } from "./company-bits";
import type { Bot, BotAsk, CompanyTicket } from "./company-types";

/* One ticket: goal, assignee, latest update and its asks. The bot's own
   transcript stays at its provider (#746: the provider owns transcripts). */
export function TicketDetail({
  ticket,
  bot,
  asks,
  onClose,
}: {
  ticket: CompanyTicket;
  bot?: Bot;
  asks: BotAsk[];
  onClose: () => void;
}) {
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto rounded-xl border bg-background p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              {ticket.id}
            </span>
            <TicketStatePill state={ticket.state} />
          </div>
          <h3 className="mt-1 font-semibold text-[15px] leading-snug">
            {ticket.title}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close ticket"
        >
          <XIcon />
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-[12.5px]">
        <dt className="text-muted-foreground">Goal</dt>
        <dd>{ticket.goal}</dd>
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="flex items-center gap-2">
          {bot ? (
            <>
              <BotAvatar bot={bot} size={20} />
              {bot.name}
              <ProviderChip provider={bot.provider} />
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted-foreground">Latest</dt>
        <dd>
          {ticket.update}{" "}
          <span className="text-muted-foreground">· {ticket.updatedAgo}</span>
        </dd>
      </dl>
      {asks.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t pt-3">
          {asks.map((a) => (
            <div key={a.id} className="text-[12.5px]">
              <span className="text-muted-foreground">
                {bot?.name ?? a.bot} asked:
              </span>{" "}
              {a.text}
              {a.ceoAnswer && (
                <div className="text-muted-foreground">
                  <span className="font-medium text-foreground">CEO:</span>{" "}
                  {a.ceoAnswer}
                </div>
              )}
              {a.risk && !a.ceoAnswer && (
                <div className="text-amber-700 dark:text-amber-400">
                  Waiting for you
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
