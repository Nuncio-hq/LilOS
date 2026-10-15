import {
  CheckIcon,
  ChevronDownIcon,
  CrownIcon,
  Maximize2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago, StateDot } from "./v2-bits";
import { RUNTIME_NAME, RuntimeIcon } from "./v2-runtime";
import { Composer } from "./v2-thread";
import type { V2Agent, V2Thread } from "./v2-types";
import { WorkLog } from "./v2-worklog";

/* Ticket ids inside a CEO reply become chips: click one and its trail opens
   on the board, so the chat and the board stay one surface. */
function withTicketChips(
  text: string,
  ids: string[],
  onTicket: (id: string) => void,
) {
  if (ids.length === 0) return text;
  const re = new RegExp(
    `\\b(${ids.map((i) => i.replace("-", "\\-")).join("|")})\\b`,
    "g",
  );
  const parts = text.split(re);
  return parts.map((p, i) =>
    ids.includes(p) ? (
      <button
        key={i}
        type="button"
        onClick={() => onTicket(p)}
        className="mx-0.5 inline-flex h-5 items-center rounded-md bg-foreground/[0.07] px-1.5 align-baseline font-mono font-medium text-[11.5px] hover:bg-foreground/[0.12]"
      >
        {p}
      </button>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/* Which CEO session the dock shows. The CEO keeps one thread per goal, so
   the picker lists them newest first with their state, plus a new one. */
function SessionPicker({
  sessions,
  value,
  onPick,
  onNew,
}: {
  sessions: V2Thread[];
  value?: string;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = sessions.find((s) => s.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="CEO session"
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-foreground/[0.05] aria-expanded:bg-foreground/[0.05]"
          />
        }
      >
        {cur && <StateDot state={cur.state} />}
        <span className="min-w-0 flex-1 truncate font-medium text-[13px]">
          {cur?.title ?? "New session"}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
          Sessions with the CEO
        </div>
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              onPick(s.id);
              setOpen(false);
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-foreground/[0.05]"
          >
            <span className="grid w-2 place-items-center">
              <StateDot state={s.state} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{s.title}</span>
              {s.line && (
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  {s.line}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {ago(s.ago)}
            </span>
            {s.id === value && (
              <CheckIcon className="size-3.5 shrink-0 text-primary" />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onNew();
            setOpen(false);
          }}
          className="mt-1 flex h-9 w-full items-center gap-2.5 rounded-md border-foreground/[0.06] border-t px-2 text-left text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
          New session
        </button>
      </PopoverContent>
    </Popover>
  );
}

/* Chat with the CEO without leaving the board: a panel docked on the right
   of Work. The header says who holds the position and on what runtime and
   model; the session picker chooses which conversation; ticket ids in a
   reply open that ticket's trail. Expand opens the full thread. */
export function V2CeoDock({
  ceo,
  sessions,
  sessionId,
  ticketIds,
  onSession,
  onNewSession,
  onSend,
  onTicket,
  onExpand,
  onClose,
}: {
  ceo: V2Agent;
  /** The CEO's threads, newest first. */
  sessions: V2Thread[];
  sessionId?: string;
  /** Ticket ids that exist, so mentions become chips. */
  ticketIds: string[];
  onSession: (id: string) => void;
  onNewSession: () => void;
  onSend: (text: string) => void;
  onTicket: (id: string) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const t = sessions.find((s) => s.id === sessionId);
  return (
    <aside
      aria-label="CEO"
      className="lilos-v2-push flex min-h-0 w-full shrink-0 flex-col border-foreground/[0.07] border-l bg-[var(--v2-main)] md:w-[380px] xl:w-[420px]"
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 px-3">
        <span className="relative shrink-0">
          <HermesAvatar
            name={ceo.name}
            status={t?.state === "working" ? "busy" : "online"}
            className="size-8"
          />
          <CrownIcon className="absolute -top-1.5 -right-1 size-3.5 text-amber-500" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-[13.5px]">
              {ceo.name}
            </span>
            <span className="rounded-full bg-amber-500/15 px-1.5 font-semibold text-[10px] text-amber-700 dark:text-amber-300">
              CEO
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <RuntimeIcon runtime={ceo.runtime} bare className="size-3" />
            {RUNTIME_NAME[ceo.runtime]} · {ceo.model}
          </div>
        </div>
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
          title="Close  Esc"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="flex shrink-0 items-center gap-1 border-foreground/[0.06] border-y px-2 py-1">
        <SessionPicker
          sessions={sessions}
          value={sessionId}
          onPick={onSession}
          onNew={onNewSession}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-4 pt-4 pb-4">
          {!t && (
            <div className="grid place-items-center gap-2 pt-16 text-center">
              <HermesAvatar name={ceo.name} className="size-10" />
              <p className="font-medium text-[14px]">
                What should the company work on?
              </p>
              <p className="max-w-64 text-[12.5px] text-muted-foreground">
                Give the CEO a goal. It splits it into tickets on the board.
              </p>
            </div>
          )}
          {t?.messages.map((m, i) =>
            m.from === "you" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-[18px] bg-foreground/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {ceo.name}
                  </span>
                  {m.time}
                </div>
                {m.work && <WorkLog steps={m.work} />}
                <p className="text-[13.5px] text-foreground/90 leading-[1.6]">
                  {withTicketChips(m.text, ticketIds, onTicket)}
                </p>
              </div>
            ),
          )}
          {t?.state === "working" && (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="lilos-v2-breathe inline-block size-2 rounded-full border-[1.5px] border-work" />
              <Shimmer as="span" duration={1.4} className="text-[12px]">
                {t.line ?? "Working…"}
              </Shimmer>
            </div>
          )}
        </div>
      </div>
      <div className={cn("shrink-0 [&>div]:px-3 [&>div]:pb-3")}>
        <Composer
          placeholder={t ? `Message ${ceo.name}` : "Describe a goal"}
          onSend={onSend}
        />
      </div>
    </aside>
  );
}
