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
   kicker line, serif title, status line, and the work strip. It is the first
   child of the conversation's scroller, so it scrolls away with the thread
   (the title goes with it). What must stay reachable does not: once the
   header is out of view a slim bar sticks to the top of the column with the
   title (small), the work strip, the context meter and the ⋯ menu. Those
   controls live in ONE place at a time — the header while it shows, the bar
   after — so there is never a second copy to hover, click or find. */

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
        {strip && <WorkStrip {...strip} compact />}
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
  /** The session view's narrower column: the title is 24px, not 30px. */
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
  /** The right of the status line, in this order: the context meter, Start
      work, the ⋯ menu, the close ✕. The meter and the menu follow the
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
      <header
        ref={header}
        data-thread-header
        className="pt-7"
        style={away ? { minHeight: natural.current } : undefined}
      >
        {kicker && (
          <div
            className={cn(
              "text-muted-foreground",
              session ? "mb-1.5 text-[13px]" : "mb-2 text-[13.5px]",
            )}
          >
            {kicker}
          </div>
        )}
        {titleInput ? (
          <div className={cn("flex", session ? "mb-3" : "mb-3.5")}>
            {titleInput}
          </div>
        ) : (
          <h1
            data-session-title
            title={title}
            className={cn(
              "lilos-v3-serif break-words font-bold text-foreground leading-[1.15]",
              session ? "mb-3 text-[24px] leading-[1.2]" : "mb-3.5 text-[30px]",
            )}
          >
            {title}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13.5px] text-muted-foreground">
          {status && (
            <StatusPill
              status={status}
              label={status === "done" ? "Finished" : undefined}
            />
          )}
          <span>
            {started ? `Started ${started}` : null}
            {turns
              ? `${started ? " · " : ""}${turns} ${turns === 1 ? "turn" : "turns"}`
              : null}
            {note}
          </span>
          {aside && (
            <span className="ml-auto flex items-center gap-1">
              {here && meter}
              {start}
              {here && menu}
              {close}
            </span>
          )}
        </div>
        {here && strip && <WorkStrip {...strip} />}
      </header>
    </>
  );
}
