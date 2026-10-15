import { Maximize2Icon, TargetIcon, XIcon } from "lucide-react";
import { CeoConversation, CeoIdentity, CeoSessionPicker } from "./v2-ceo-chat";
import type { V2Agent, V2Thread } from "./v2-types";
import type { V2Goal } from "./v2-work-types";

/* Chat with the CEO without leaving the board: a panel docked on the right
   of Work. Header: who holds the position, on what runtime and model. Then
   which conversation (a goal's, or a plain chat). When the conversation is
   a goal's, the board highlights that goal's tickets and a line here says
   so, with a way to stop. */
export function V2CeoDock({
  ceo,
  sessions,
  goals,
  sessionId,
  ticketIds,
  goalTickets,
  highlight,
  about,
  onClearAbout,
  onSession,
  onNewSession,
  onSend,
  onTicket,
  onHighlight,
  onExpand,
  onClose,
}: {
  ceo: V2Agent;
  /** The CEO's threads, newest first. */
  sessions: V2Thread[];
  goals: V2Goal[];
  sessionId?: string;
  /** Ticket ids that exist, so mentions become chips. */
  ticketIds: string[];
  /** How many tickets the picked session's goal has. */
  goalTickets: number;
  /** The board is highlighting the picked goal's tickets. */
  highlight: boolean;
  about?: { id: string; title: string };
  onClearAbout?: () => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
  onSend: (text: string) => void;
  onTicket: (id: string) => void;
  onHighlight: (on: boolean) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const t = sessions.find((s) => s.id === sessionId);
  const goal = goals.find((g) => g.id === t?.goalId);
  return (
    <aside
      aria-label="CEO"
      className="lilos-v2-push flex min-h-0 w-full shrink-0 flex-col border-foreground/[0.07] border-l bg-[var(--v2-main)] md:w-[380px] xl:w-[420px]"
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1">
          <CeoIdentity ceo={ceo} busy={t?.state === "working"} />
        </span>
        <button
          type="button"
          onClick={onExpand}
          aria-label="Open full thread"
          title="Open full thread"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Maximize2Icon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close CEO panel"
          title="Close"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="flex shrink-0 flex-col gap-1 border-foreground/[0.06] border-y px-2 py-1.5">
        <CeoSessionPicker
          sessions={sessions}
          goals={goals}
          value={sessionId}
          onPick={onSession}
          onNew={onNewSession}
        />
        {goal && (
          <button
            type="button"
            onClick={() => onHighlight(!highlight)}
            aria-pressed={highlight}
            className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[11.5px] text-muted-foreground hover:bg-foreground/[0.04] aria-pressed:text-amber-700 dark:aria-pressed:text-amber-300"
          >
            <TargetIcon className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {highlight
                ? `Highlighting this goal's ${goalTickets} tickets on the board`
                : `Show this goal's ${goalTickets} tickets on the board`}
            </span>
            <span className="shrink-0 font-medium underline-offset-2 hover:underline">
              {highlight ? "Clear" : "Show"}
            </span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CeoConversation
          ceo={ceo}
          thread={t}
          ticketIds={ticketIds}
          about={about}
          onClearAbout={onClearAbout}
          onTicket={onTicket}
          onSend={onSend}
        />
      </div>
    </aside>
  );
}
