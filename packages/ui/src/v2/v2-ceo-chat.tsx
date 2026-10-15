import {
  CheckIcon,
  ChevronDownIcon,
  CrownIcon,
  MessagesSquareIcon,
  PlusIcon,
  TargetIcon,
  TicketIcon,
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
import type { V2Goal } from "./v2-work-types";
import { WorkLog } from "./v2-worklog";

/* Talking to the CEO, as one piece two surfaces share: the panel docked on
   the right of Work, and the bottom of a ticket's sheet.

   The words:
   - a GOAL is what the owner wants ("Grow HeardBack's paywall conversion").
     The owner sets it by telling the CEO; the CEO writes it on the board and
     splits it into tickets.
   - a SESSION is one conversation with the CEO. The session where a goal
     was asked for is that goal's session; a session can also be a question
     about one ticket, or anything else.
   Picking a session that belongs to a goal highlights that goal's tickets
   on the board. */

/* Ticket ids inside a CEO reply become chips that open the ticket. */
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
  return text.split(re).map((p, i) =>
    ids.includes(p) ? (
      <button
        key={i}
        type="button"
        onClick={() => onTicket(p)}
        className="mx-0.5 inline-flex h-5 items-center rounded-md bg-foreground/[0.07] px-1.5 align-baseline font-medium font-mono text-[11.5px] hover:bg-foreground/[0.12]"
      >
        {p}
      </button>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/* Which conversation with the CEO. Each row says what it is: a goal (target
   icon, the goal's name, its tickets) or a plain chat (bubble icon). */
export function CeoSessionPicker({
  sessions,
  goals,
  value,
  onPick,
  onNew,
  compact,
}: {
  sessions: V2Thread[];
  goals: V2Goal[];
  value?: string;
  onPick: (id: string) => void;
  onNew: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cur = sessions.find((s) => s.id === value);
  const goalOf = (s?: V2Thread) => goals.find((g) => g.id === s?.goalId);
  const curGoal = goalOf(cur);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="CEO session"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-foreground/[0.05] aria-expanded:bg-foreground/[0.05]",
              compact ? "h-8" : "h-10",
            )}
          />
        }
      >
        {curGoal ? (
          <TargetIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          {!compact && (
            <span className="block text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
              {curGoal ? "Goal" : cur ? "Chat" : "New"}
            </span>
          )}
          <span className="block truncate font-medium text-[13px]">
            {curGoal?.title ?? cur?.title ?? "New conversation"}
          </span>
        </span>
        {cur && <StateDot state={cur.state} />}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
          Conversations with the CEO
        </div>
        {sessions.map((s) => {
          const g = goalOf(s);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onPick(s.id);
                setOpen(false);
              }}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-foreground/[0.05]"
            >
              {g ? (
                <TargetIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{g?.title ?? s.title}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <StateDot state={s.state} />
                  {s.ticketIds && s.ticketIds.length > 0 && (
                    <span className="shrink-0 font-mono">
                      {s.ticketIds.slice(0, 3).join(" ")}
                      {s.ticketIds.length > 3 ? " …" : ""}
                    </span>
                  )}
                  <span className="truncate">{s.line}</span>
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {ago(s.ago)}
              </span>
              {s.id === value && (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            onNew();
            setOpen(false);
          }}
          className="mt-1 flex h-9 w-full items-center gap-2.5 rounded-md border-foreground/[0.06] border-t px-2 text-left text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
          New conversation
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** The CEO's name, crown, runtime and model, in one line. */
export function CeoIdentity({
  ceo,
  busy,
  size = "md",
}: {
  ceo: V2Agent;
  busy?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="relative shrink-0">
        <HermesAvatar
          name={ceo.name}
          status={busy ? "busy" : "online"}
          className={size === "sm" ? "size-6" : "size-8"}
        />
        <CrownIcon className="absolute -top-1.5 -right-1 size-3.5 text-amber-500" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-[13.5px]">
            {ceo.name}
          </span>
          <span className="rounded-full bg-amber-500/15 px-1.5 font-semibold text-[10px] text-amber-700 dark:text-amber-300">
            CEO
          </span>
        </span>
        {size === "md" && (
          <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <RuntimeIcon runtime={ceo.runtime} bare className="size-3" />
            {RUNTIME_NAME[ceo.runtime]} · {ceo.model}
          </span>
        )}
      </span>
    </span>
  );
}

/* The conversation itself: messages (ticket ids as chips, "about HB-10"
   on messages sent from a ticket), the live line, and the composer with the
   ticket attached when there is one. */
export function CeoConversation({
  ceo,
  thread,
  ticketIds,
  about,
  onClearAbout,
  onTicket,
  onSend,
  hideAbout,
  emptyHint,
}: {
  ceo: V2Agent;
  thread?: V2Thread;
  ticketIds: string[];
  about?: { id: string; title: string };
  onClearAbout?: () => void;
  onTicket: (id: string) => void;
  onSend: (text: string) => void;
  /** Inside a ticket's sheet the ticket is implied: no "about" chips. */
  hideAbout?: boolean;
  emptyHint?: string;
}) {
  return (
    <>
      <div className="flex flex-col gap-5 px-4 pt-4 pb-4">
        {!thread && (
          <div className="grid place-items-center gap-2 py-10 text-center">
            <HermesAvatar name={ceo.name} className="size-10" />
            <p className="font-medium text-[14px]">
              {emptyHint ?? "What should the company work on?"}
            </p>
            {!emptyHint && (
              <p className="max-w-64 text-[12.5px] text-muted-foreground">
                Tell the CEO a goal. It writes it on the board and splits it
                into tickets.
              </p>
            )}
          </div>
        )}
        {thread?.messages.map((m, i) =>
          m.from === "you" ? (
            <div key={i} className="flex flex-col items-end gap-1">
              {m.ticketId && !hideAbout && (
                <button
                  type="button"
                  onClick={() => onTicket(m.ticketId as string)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <TicketIcon className="size-3" />
                  about <span className="font-mono">{m.ticketId}</span>
                </button>
              )}
              <div className="max-w-[85%] rounded-[18px] bg-foreground/[0.06] px-3.5 py-2 text-[13.5px] leading-relaxed">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <span className="font-medium text-foreground">{ceo.name}</span>
                {m.time}
              </div>
              {m.work && <WorkLog steps={m.work} />}
              <p className="text-[13.5px] text-foreground/90 leading-[1.6]">
                {withTicketChips(m.text, ticketIds, onTicket)}
              </p>
            </div>
          ),
        )}
        {thread?.state === "working" && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="lilos-v2-breathe inline-block size-2 rounded-full border-[1.5px] border-work" />
            <Shimmer as="span" duration={1.4} className="text-[12px]">
              {thread.line ?? "Working…"}
            </Shimmer>
          </div>
        )}
      </div>
      <div className="shrink-0 [&>div]:px-3 [&>div]:pb-3">
        <Composer
          placeholder={
            about
              ? `Ask the CEO about ${about.id}…`
              : thread
                ? `Message ${ceo.name}`
                : "Describe a goal"
          }
          onSend={onSend}
          above={
            about &&
            !hideAbout && (
              <div className="mb-1 flex items-center gap-1.5 px-1.5 pt-0.5">
                <span className="flex min-w-0 items-center gap-1.5 rounded-lg bg-foreground/[0.06] py-1 pr-1 pl-2 text-[12px]">
                  <TicketIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium font-mono">
                    {about.id}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {about.title}
                  </span>
                  {onClearAbout && (
                    <button
                      type="button"
                      onClick={onClearAbout}
                      aria-label={`Stop asking about ${about.id}`}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </span>
              </div>
            )
          }
        />
      </div>
    </>
  );
}
