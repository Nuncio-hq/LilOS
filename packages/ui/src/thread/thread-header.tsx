import { PlayIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Thread, WbTab } from "../types";
import { StatusPill } from "../v3/v3-marks";
import type { V3Status } from "../v3/v3-types";
import { type HeaderTab, WorkStrip } from "./work-strip";

/* The head of a conversation — shared by the panel (ThreadView, beside the
   list) and the session view (FocusView), drawn once so the two can't drift:
   the serif title (the folder/branch kicker at its right), then ONE line —
   status · started · turns on the left, the work strip and the context meter
   and ⋯ on the right. It is the first child of the conversation's scroller,
   so it scrolls away with the thread (the title goes with it). What must
   stay reachable does not: once the header is out of view a slim bar sticks
   to the top of the column with the title (small), the work strip, the
   context meter and the ⋯ menu. Those controls live in ONE place at a time —
   the header while it shows, the bar after — so there is never a second
   copy to hover, click or find. */

export type WorkStripProps = {
  tabs: HeaderTab[];
  onOpen: (tab: WbTab) => void;
};

/** How many messages the person has sent — root included; system notes and
    the agent's own turns don't count. */
export function sentTurns(
  rootFrom: string,
  thread: Thread,
  human: (id: string) => unknown,
): number {
  return (
    (human(rootFrom) ? 1 : 0) +
    thread.replies.filter((r) => !r.system && human(r.from)).length
  );
}

/** Start work — one entry point for both frames (issue #15): while the
    request card in the conversation is open the button yields to it,
    disabled + a tooltip. The title lives on the wrapper because a disabled
    button ignores pointer events and would swallow the hover. */
export function StartWork({
  onStart,
  yields,
}: {
  onStart: () => void;
  yields: boolean;
}) {
  return (
    <span
      className="ml-1 inline-flex shrink-0"
      title={
        yields
          ? "Answer the request below"
          : "New ticket + worktree for this thread"
      }
    >
      <Button
        size="sm"
        onClick={onStart}
        disabled={yields}
        data-startwork-header
      >
        <PlayIcon />
        Start work
      </Button>
    </span>
  );
}

/* The nearest ancestor that scrolls — the conversation's port. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
}

/* True once `ref`'s element has scrolled out of its port off the top. An
   element with no box (hidden panel) is not "scrolled away". */
function useScrolledAway(ref: RefObject<HTMLElement | null>): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    /* The callback gets every record queued since the last frame, oldest
       first — the first-observation record and the pin's scroll can arrive
       together, and only the newest says where the header is now. */
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        setAway(
          !e.isIntersecting &&
            e.boundingClientRect.height > 0 &&
            e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0),
        );
      },
      { root: scrollParent(el) },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return away;
}

/* The slim bar. It has no height of its own (a zero-height sticky row whose
   bar hangs from it), so showing or hiding it never moves a turn; `-mb-7`
   cancels the column's `gap-7` after that empty row. The `bar` container
   lets the strip show labels only when there is room. */
function ThreadBar({
  title,
  strip,
  meter,
  menu,
}: {
  title: string;
  strip?: WorkStripProps;
  meter?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="@container/bar sticky top-0 z-20 -mb-7 h-0">
      <div
        data-thread-bar
        className="-mx-8 absolute inset-x-0 top-0 flex h-10 items-center gap-1.5 border-[var(--v3-line)] border-b bg-[var(--v3-main)] px-8"
      >
        <div className="min-w-0 flex-1">
          <span
            title={title}
            className="hidden truncate font-medium text-[13px] text-foreground @[20rem]/bar:block"
          >
            {title}
          </span>
        </div>
        {strip && <WorkStrip {...strip} placement="bar" />}
        {meter}
        {menu}
      </div>
    </div>
  );
}

export function ThreadHeader({
  session,
  title,
  titleInput,
  kicker,
  status,
  started,
  turns,
  note,
  meter,
  start,
  menu,
  close,
  strip,
}: {
  /** The session view's narrower column: the title is 20px, not 22px. */
  session: boolean;
  title: string;
  /** Replaces the title while it is being renamed. */
  titleInput?: ReactNode;
  kicker?: ReactNode;
  status?: V3Status;
  /** When the thread began ("11:02"); empty = not known. */
  started?: string;
  turns?: number;
  /** A live note after the facts ("1 running in background"). */
  note?: ReactNode;
  /** The right end of the facts line, in this order: the context meter,
      Start work, the ⋯ menu, the close ✕. The meter and the menu follow the
      reader to the sticky bar; Start work and ✕ stay with the header. */
  meter?: ReactNode;
  start?: ReactNode;
  menu?: ReactNode;
  close?: ReactNode;
  /** The work strip; absent = the thread has no way to open work. */
  strip?: WorkStripProps;
}) {
  const header = useRef<HTMLElement>(null);
  const away = useScrolledAway(header);
  /* The header keeps its height while its controls sit in the bar: it is
     above the fold, and a header that shrank would pull every turn under it
     up the screen. */
  const natural = useRef(0);
  useLayoutEffect(() => {
    if (!away && header.current) natural.current = header.current.offsetHeight;
  });
  const here = !away;
  const aside = (here && (meter || menu)) || start || close;
  return (
    <>
      {away && (
        <ThreadBar title={title} strip={strip} meter={meter} menu={menu} />
      )}
      {/* No top strip of its own: the window's toolbar is right above, so a
          10px pad is all the title needs. `-mb-3` takes 12px off the column's
          28px gap, so the first turn starts 16px under the line. */}
      <header
        ref={header}
        data-thread-header
        className="-mb-3 pt-2.5"
        style={away ? { minHeight: natural.current } : undefined}
      >
        {/* The kicker rides the title's row, right-aligned, and gives way
            first: its basis is small, so it only drops below when the title
            leaves it under 8rem, and a branch name truncates before that. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {titleInput ? (
            <div className="flex min-w-0 flex-[1_1_14rem]">{titleInput}</div>
          ) : (
            <h1
              data-session-title
              title={title}
              className={cn(
                "lilos-v3-serif min-w-0 flex-[0_1_auto] break-words font-bold text-foreground",
                /* The size first: twMerge drops a `leading-*` that came before
                   a `text-[Npx]`. */
                session
                  ? "text-[20px] leading-[1.2]"
                  : "text-[22px] leading-[1.2]",
              )}
            >
              {title}
            </h1>
          )}
          {kicker && (
            <div className="min-w-0 flex-[1_1_8rem] text-right text-[12.5px] text-muted-foreground">
              {kicker}
            </div>
          )}
        </div>
        {/* The `line` container: wide, status · started · turns, then the
            work strip, then the meter and ⋯, in one row; narrow, the strip
            drops to a row of its own (work-strip.tsx owns that switch). */}
        <div className="@container/line mt-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted-foreground @[30rem]/line:flex-nowrap">
            <div className="flex min-w-0 flex-1 items-baseline gap-x-2">
              {status && (
                <StatusPill
                  status={status}
                  label={status === "done" ? "Finished" : undefined}
                />
              )}
              <span className="min-w-0">
                {started ? `Started ${started}` : null}
                {turns
                  ? `${started ? " · " : ""}${turns} ${turns === 1 ? "turn" : "turns"}`
                  : null}
                {note}
              </span>
            </div>
            {here && strip && <WorkStrip {...strip} />}
            {aside && (
              <span className="flex shrink-0 items-center gap-1">
                {here && meter}
                {start}
                {here && menu}
                {close}
              </span>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
