/* Shared agent-chat building blocks — THE chat with an agent. Both the thread panel (ThreadView, also used
   for DM sessions) and the Focus workbench (AgentTurn / FocusComposer) render steers, the waiting and
   not-sent trays, and the running-state composer hints from here, so the two surfaces can never drift. Chat is the important
   part; everything else inherits it. */
import {
  CheckIcon,
  CircleStopIcon,
  ClockIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useLayoutEffect } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";

/* Steer is a declared engine capability (Engine protocol: session.steer), not a constant: the host
   reads describe().capabilities once and passes `steer` to ThreadView/FocusView. A message sent while
   the turn runs waits in the QueuedTray above the composer either way — the conversation only ever
   shows what the agent has actually read. With `steer` it joins the running turn at the next tool
   boundary (and becomes a landed "{by} steered" row inside that turn); without it, or if the turn
   ends first, it runs as the next prompt (issue #9). Not: a capability toggle in the composer; not:
   pending chips inside the live turn (they read as if the agent were already answering them). */

/* Strip markdown markers for chips/trays (single copy shared by the app and these components). */
export const plain = (s: string) =>
  s
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/* One steer that LANDED inside a running turn: applied at a tool boundary, so it sits in the turn at
   that point. Right-aligned and labelled with the user's name so it reads as their message inside the
   agent's turn, not agent output. Solid amber-100 + amber-950 text keeps the chip AA-readable in
   light; dark melts it into the same amber tint family as the flash rows (amber-900/40) with the
   remapped light text. While a
   steer still waits it lives in the QueuedTray, never here. */
export function SteerRow({
  text,
  by,
}: {
  text: string;
  /** The human who steered — the label reads "{by} steered" (#118). */
  by: string;
}) {
  return (
    <div
      data-steerstate="landed"
      className={cn(
        // mt-2 keeps the chip clearly separated from the agent's text above it — it must never read
        // as part of the agent's output (issue #15).
        "ml-auto mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-md border border-amber-300 border-solid bg-amber-100 px-2 py-1 text-amber-950 text-xs dark:bg-amber-900/40",
      )}
    >
      <CheckIcon className="mt-0.5 size-3 shrink-0 text-emerald-700" />
      <span className="shrink-0 font-semibold">{`${by} steered`}</span>
      <span className="min-w-0">{plain(text)}</span>
    </div>
  );
}

/* Landed steers of one agent turn. Used by the thread panel and Focus identically. */
export function SteerRows({
  steers,
  by,
}: {
  steers?: string[];
  /** The human who steered — shown on each row (#118). */
  by: string;
}) {
  return (
    <>
      {(steers ?? []).map((s, k) => (
        <SteerRow key={k} text={s} by={by} />
      ))}
    </>
  );
}

/* Re-stick the conversation to the bottom when the composer AREA grows — the not-sent tray appearing
   after ■ (or a pending steer chip changing layout) shrinks the scroll viewport from below, but
   use-stick-to-bottom's ResizeObserver only watches the content element, so nothing re-scrolls and the
   stopped turn ends up hidden under the tray (issue #15). This renders inside <Conversation> and uses
   the library's own scrollToBottom — no intervals, no DOM poking. Pass a signal that changes whenever
   the area below the conversation changes size (e.g. the tray's item count). */
export function ConversationKeepBottom({
  signal,
}: {
  signal: number | string;
}) {
  const { scrollToBottom, scrollRef } = useStickToBottomContext();
  /* Layout effect + a synchronous write: even "instant" scrollToBottom hops
     through a rAF, so the frame after the composer column grows would lay out
     (and could paint) the last card clipped under the tray — the PR #358
     waiting-tray overlap. The lib call keeps its bottom-lock bookkeeping. */
  useLayoutEffect(() => {
    scrollToBottom({ animation: "instant" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [signal, scrollToBottom, scrollRef]);
  return null;
}

/* Messages that did NOT land because the user pressed ■ (session.interrupt). There is no "this turn"
   anymore, so nothing is "sent after this turn" and nothing auto-runs: each item waits with visible,
   keyboard-reachable actions — Send (runs it now as a new prompt in this thread) and remove.
   thread.queue holds ONLY these. Used by the thread panel composer and the Focus tray.
   Action hierarchy (issue #15): Send is THE primary action (solid blue); remove is a neutral muted
   icon that only turns red on hover, so the destructive action never reads as the primary one. */
export function NotSentTray({
  items,
  onSend,
  onRemove,
}: {
  items: string[];
  /* Each action renders only with its handler (issue #19); without both the tray is
     still shown — the items and the "not sent" label are information, not controls. */
  onSend?: (i: number) => void;
  onRemove?: (i: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div
      className="mb-1.5 rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1.5 text-xs"
      data-notsent
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium text-blue-900">
        <CircleStopIcon className="size-3.5 shrink-0" />
        {items.length} not sent · turn stopped
      </div>
      <ul>
        {items.map((q, i) => (
          <li key={i} className="flex items-center gap-2 py-0.5">
            <span className="shrink-0 font-mono text-[10px] text-blue-700">
              {i + 1}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-blue-950"
              title={plain(q)}
            >
              {plain(q)}
            </span>
            {onSend && (
              <button
                type="button"
                onClick={() => onSend(i)}
                data-notsent-send={i}
                className="shrink-0 rounded bg-blue-600 px-2 py-0.5 font-medium text-white hover:bg-blue-700"
              >
                Send
              </button>
            )}
            {onRemove && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onRemove(i)}
                        aria-label="Remove"
                        data-notsent-remove={i}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
                      />
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Messages sent while the employee works that it has NOT read yet — one tray above the composer for
   every engine, so a waiting message never shows up in the conversation as if it were being answered.
   · steer declared: each joins the running turn at the next step (then shows as a landed steer row
     inside that turn); if the turn ends first it runs next instead — a message is never lost.
   · no steer: they run in order, one prompt each, when the turn ends (issue #9).
   Edit pulls an item back into the composer (it leaves the queue); Remove drops it. Neither is a Send:
   sending now is impossible mid-turn — ■ stops the turn, and anything still here moves to the not-sent
   tray. Amber: the "waiting on the turn" family (the landed steer rows share it).
   Rows are bare strings, or `{text, removable}` (#315): the engine already holds an
   accepted-but-unlanded steer (`removable: false`), so its row lists in the tray but
   Edit/Remove stay hidden. */
export type QueuedTrayItem = string | { text: string; removable?: boolean };

/** Item text for callers that take the row back (e.g. Edit → composer). */
export const queuedItemText = (item: QueuedTrayItem): string =>
  typeof item === "string" ? item : item.text;

const queuedItemRemovable = (item: QueuedTrayItem): boolean =>
  typeof item === "string" || item.removable !== false;

export function QueuedTray({
  items,
  steer = false,
  name = "The employee",
  onRemove,
  onEdit,
}: {
  items: QueuedTrayItem[];
  /** Engine declared session.steer — changes when each item gets read. */
  steer?: boolean;
  /** Employee name for the header ("Builder hasn't read these yet"). */
  name?: string;
  /* Each action renders only with its handler, like NotSentTray; a
     `removable: false` item (steer the engine already took) hides them. */
  onRemove?: (i: number) => void;
  onEdit?: (i: number) => void;
}) {
  if (!items.length) return null;
  const one = items.length === 1;
  return (
    <div
      className="mb-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs"
      data-queued
      data-queued-mode={steer ? "steer" : "next"}
    >
      <div className="flex items-center gap-1.5 font-medium text-amber-900">
        <ClockIcon className="size-3.5 shrink-0 animate-pulse" />
        {items.length} waiting · {name} hasn&apos;t read {one ? "it" : "them"}{" "}
        yet
      </div>
      <div className="mb-1 pl-5 text-[11px] text-amber-800" data-queued-when>
        {steer
          ? `${one ? "Lands" : "Each lands"} at the next step of this turn, or runs next`
          : `${one ? "Runs" : "Run in order"} when this turn ends`}
      </div>
      <ul>
        {items.map((q, i) => (
          <li key={i} className="group/q flex items-center gap-2 py-0.5">
            <span className="shrink-0 font-mono text-[10px] text-amber-700">
              {i + 1}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-amber-950"
              title={plain(queuedItemText(q))}
            >
              {plain(queuedItemText(q))}
            </span>
            <TooltipProvider>
              {onEdit && queuedItemRemovable(q) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onEdit(i)}
                        aria-label="Edit"
                        data-queued-edit={i}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-amber-100 hover:text-amber-900"
                      />
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Edit · moves it back to the box
                  </TooltipContent>
                </Tooltip>
              )}
              {onRemove && queuedItemRemovable(q) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onRemove(i)}
                        aria-label="Remove"
                        data-queued-remove={i}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
                      />
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Running-state composer copy, one source for both surfaces: whether Enter steers the running turn
   or queues for after it depends on the engine's declared steer capability (issue #9). Idle hints
   stay surface-specific at the call sites. `agentWork` (#308): while an engine-initiated leg runs
   there's no user turn to steer — Enter queues, and the placeholder names whose work it is. */
export const runningComposer = (
  name: string,
  steer: boolean,
  agentWork = false,
) => ({
  placeholder: agentWork
    ? `${name} is working on its own. Enter queues it for when the turn ends…`
    : steer
      ? `${name} is working. Enter steers this turn…`
      : `${name} is working. Enter queues it for when the turn ends…`,
  hint: steer && !agentWork ? "Enter steers · ■ stop" : "Enter queues · ■ stop",
});
