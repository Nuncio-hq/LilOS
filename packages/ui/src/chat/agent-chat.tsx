/* Shared agent-chat building blocks — THE chat with an agent. Both the thread panel (ThreadView, also used
   for DM sessions) and the Focus workbench (AgentTurn / FocusComposer) render steers, the stopped-queue tray,
   and the running-state composer hints from here, so the two surfaces can never drift. Chat is the important
   part; everything else inherits it. */
import { CheckIcon, CircleStopIcon, ClockIcon, Trash2Icon } from "lucide-react";
import { useEffect } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";

/* Engine capability read in ONE place (Engine protocol: session.steer). Steer is the default and only
   behavior: a message sent while the employee works lands in the running turn at the next tool boundary.
   A future engine without session.steer (or a user setting) flips this single constant and mid-turn
   sends take the queue path instead — no UI for that yet. Not: a capability toggle in the composer. */
export const ENGINE_STEER = true;

/* Strip markdown markers for chips/trays (single copy shared by the app and these components). */
export const plain = (s: string) =>
  s
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/* One steer Oscar sent into a running turn, in one of its two states — same shape in both, so the chip
   that waits is recognisably the same object as the row that landed:
   · pending: waiting at the bottom of the live turn (dashed border, clock) — session.steer accepted, not
     yet delivered.
   · landed: applied at a tool boundary inside the turn (solid border, check).
   Right-aligned and labelled "Oscar" so it reads as Oscar's message inside the agent's turn, not agent
   output. Solid amber-100 + amber-950 text keeps the chip AA-readable (the old /40 bg with 70% text was not). */
export function SteerRow({
  text,
  state,
}: {
  text: string;
  state: "pending" | "landed";
}) {
  const waiting = state === "pending";
  return (
    <div
      data-steerpending={waiting || undefined}
      data-steerstate={state}
      className={cn(
        // mt-2 keeps the chip clearly separated from the agent's text above it — it must never read
        // as part of the agent's output (issue #15). Applies to pending chips and landed rows alike.
        "ml-auto mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-md border bg-amber-100 px-2 py-1 text-amber-950 text-xs",
        waiting
          ? "border-dashed border-amber-300"
          : "border-solid border-amber-300",
      )}
    >
      {waiting ? (
        <ClockIcon className="mt-0.5 size-3 shrink-0 animate-pulse text-amber-700" />
      ) : (
        <CheckIcon className="mt-0.5 size-3 shrink-0 text-emerald-700" />
      )}
      <span className="shrink-0 font-semibold">
        {waiting ? "Oscar steers" : "Oscar steered"}
      </span>
      <span className="min-w-0">{plain(text)}</span>
    </div>
  );
}

/* Steers of one agent turn: landed rows, then (only while the turn is live) the chips waiting to land.
   Used by the thread panel and Focus identically. */
export function SteerRows({
  steers,
  pending,
  live,
}: {
  steers?: string[];
  pending: string[];
  live?: boolean;
}) {
  return (
    <>
      {(steers ?? []).map((s, k) => (
        <SteerRow key={k} text={s} state="landed" />
      ))}
      {live &&
        pending.map((s, k) => (
          <SteerRow key={`p${k}`} text={s} state="pending" />
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
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    // Re-locks to the bottom so the last turn + the tray are both fully visible without scrolling.
    scrollToBottom({ animation: "instant" });
  }, [signal, scrollToBottom]);
  return null;
}

/* Messages that did NOT land because Oscar pressed ■ (session.interrupt). There is no "this turn"
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

/* Running-state composer copy, one source for both surfaces: while the employee works, Enter always
   steers (ENGINE_STEER is the only mode). Idle hints stay surface-specific at the call sites. */
export const runningComposer = (name: string) => ({
  placeholder: `${name} is working. Enter steers this turn…`,
  hint: "Enter steers · ■ stop",
});
