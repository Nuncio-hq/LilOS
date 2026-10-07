import { Undo2Icon } from "lucide-react";
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConversationPin } from "../components/ai-elements/conversation";
import { Body, Row, Who } from "../feed/row";
import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import type {
  EmpFn,
  HumanFn,
  ModelOption,
  PullRequest,
  QuestionAsk,
  Reply,
  WbTab,
  Work,
} from "../types";
import { ReplyCards } from "./cards";
import { findAnchorActive, useFindUnstub } from "./find-unstub";
import type { PlanAction } from "./plan-card";
import type { QuestionAnswer } from "./question-card";
import { AgentTurn, AttachmentChips, PrCard, UserTurn } from "./turns";

/**
 * #430: one reply row, memoized so an incoming delta re-renders only the
 * row whose `Reply` changed (the incremental reducer + fold cache keep
 * every untouched reply's object identity — `r` is THE compare that
 * matters; everything else is a view input compared by identity, or
 * shallowly for the per-render `resolved`/`work` records).
 *
 * `lazy` mounts a viewport-watcher: rows far outside the scroll window
 * unmount to a measured-height stub that keeps the spec anchors
 * (`data-msg`, `data-agentturn`/`data-userturn`, `data-turnsettled` when
 * settled) and the total scroll height. Engaged only on long threads
 * (`lazy` false below it), so short threads — every e2e spec — always
 * render full DOM.
 *
 * Handlers arrive through `acts`, a ref the view rewrites each render:
 * they never render by themselves, so latest-closure reads are always
 * fresh and the memo isn't broken by per-render callback identity.
 */

/* Below this many replies every row always mounts — specs never build a
   thread this long, so their DOM contract is untouched. */
export const TURN_LAZY_AFTER = 24;

/* How far outside the viewport a row goes before it is held as a stub. */
const LAZY_MARGIN = "1600px";

/* e2e/dev knob — `?stubHydrateMs=<ms>` defers a born-stub's un-hold that
   long after its observer intersects: the CI-slow first hydration, where
   the mounts land in a quiet port long after the open pin ran and every
   estimate→real delta is a standalone scroll event (#570's slow-box
   reproducer). Read once at module load, like `?stickDropMs=`. */
const STUB_HYDRATE_MS = (() => {
  if (typeof window === "undefined") return 0;
  const v = Number(
    new URLSearchParams(window.location.search).get("stubHydrateMs"),
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

/* #570: a lazy thread's FIRST mount renders only its tail — rows older
   than an estimated `OPEN_TAIL_PX` of content start as stubs instead of
   mounting once and stubbing behind the observer (#430's measured path).
   ~3 ports of tail guarantees nothing in view starts held on any
   realistic window while the other ~95% of a 200-turn thread stays
   stubbed. */
export const OPEN_TAIL_PX = 3200;

/* Wrapped-line count at `cpl` chars/line — empty segments still cost a
   line box. Only needs to be close: a first-mount stub holds this until
   the row's real height is measured on its next hold (#537). */
const estLines = (text: string, cpl: number) =>
  text
    .split("\n")
    .reduce((a, s) => a + Math.max(1, Math.ceil(s.length / cpl)), 0);

/** Estimated px height for a never-mounted row — the #570 first-mount
    stub's stand-in. Column width decides wrap (`frame`), card kinds add
    their chrome. Never smaller than a real row; overshoot is safer than
    collapse (the pin lands at the bottom regardless). */
export function estTurnHeight(
  r: Reply,
  agent: boolean,
  frame: "panel" | "focus",
): number {
  const cpl = frame === "focus" ? 86 : 50;
  if (!agent) {
    /* Row/UserTurn: who line + wrapped text + attachment chips. */
    return 46 + estLines(r.text, cpl) * 20 + (r.attachments?.length ? 34 : 0);
  }
  /* AgentTurn: who row + optional reasoning fold + body + cards + footer. */
  let h = 60 + estLines(r.text, cpl) * 21;
  if (r.reasoning) h += 30;
  if (r.steps?.length) h += 36;
  if (r.plan) h += 40 + r.plan.steps.length * 22;
  if (r.approval || r.question) h += 110;
  if (r.startProposal) h += 56;
  if (r.subagents?.length) h += 30;
  if (r.attachments?.length) h += 34;
  if (r.error) h += 30;
  return h;
}

/** First row index that mounts real on open: walk back from the newest
    reply until `px` of estimated height is covered. */
export function openTailStart(
  heights: readonly number[],
  px = OPEN_TAIL_PX,
): number {
  let acc = 0;
  for (let i = heights.length - 1; i >= 0; i--) {
    acc += heights[i];
    if (acc >= px) return i;
  }
  return 0;
}

/** Handlers the row may fire — read via `acts.current`, never compared. */
export interface TurnActs {
  onRetry?: (empId: string) => void;
  onOpen?: (t: WbTab) => void;
  onOpenSession?: (employeeId: string, session: string) => void;
  onPlan?: (a: PlanAction, planId: string) => void;
  onRewind?: (messageId: string) => void;
  setResolved?: (r: Record<string, string>) => void;
  onStart?: () => void;
  /** #420: question-ask answer/cancel continuations. */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
}

/* #578: rewind moved off the permanent checkpoint row onto a hover
   affordance on your own message (both frames, root included) — no line
   above every message, no confirm dialog. One click applies the rewind
   visually and opens a 10 s Undo toast that is the real safeguard, so a
   shared folder (`warning`) only names itself in the tooltip, and a running
   turn still greys the affordance out (#134 AC-5). The wrapper span carries
   the tooltip because a disabled button swallows pointer events. */
export function RewindHover({
  running,
  warning,
  onRewind,
}: {
  running: boolean;
  warning?: string;
  onRewind: () => void;
}) {
  const title = running
    ? "Stop the running turn first"
    : `Rewind to before this message${warning ? ` — ${warning}` : ""}`;
  return (
    <span
      title={title}
      className="absolute top-1 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      <button
        type="button"
        data-rewind
        disabled={running}
        title={title}
        onClick={onRewind}
        className="inline-flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Undo2Icon className="size-3" />
        Rewind
      </button>
    </span>
  );
}

/* The settled marker AgentTurn's footer carries — a held stub repeats it
   so `waitSettled` keeps working on an off-screen settled turn. Strict
   terminal phases only: a mid-turn row can already carry text/steps while
   `live`/`streaming` are momentarily off, and must never fake "done".
   Feed rows map to `phase: "done"` (messageReply), so this covers them. */
const TERMINAL: ReadonlySet<Reply["phase"]> = new Set([
  "done",
  "stopped",
  "failed",
]);
const isSettled = (r: Reply) =>
  TERMINAL.has(r.phase) &&
  !!(
    r.text ||
    r.steps?.length ||
    r.subagents?.length ||
    r.phase === "stopped" ||
    r.phase === "failed"
  );

/* The `data-msg` wrapper + the held/off-screen stub. The outer div ALWAYS
   stays mounted — it's the scroll/flash anchor (#138) — only the row
   content swaps out. `data-remount` marks a row that has been re-mounted
   after a hold; theme.css uses it to skip the rise animation replay. */
function LazyShell({
  msgId,
  className,
  lazy,
  keep,
  startHeld = false,
  estHeight,
  kind,
  settled,
  children,
}: {
  msgId?: string;
  className?: string;
  lazy: boolean;
  /** Rows that must never unmount: live/streaming turns and the scrollTo
      target (its content has to exist the moment it lands, #138). */
  keep: boolean;
  /** #570: mount directly as a height-estimated stub — rows above the
      open tail never pay their mount cost on thread open. `keep` wins:
      live turns and the scroll target still mount real. */
  startHeld?: boolean;
  /** The first stub's px height — the never-measured estimate; once the
      row mounts and re-holds, the stub keeps its real height (#537). */
  estHeight?: number;
  kind: "agent" | "user" | "note";
  settled: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initialHeld = lazy && !keep && startHeld && (estHeight ?? 0) > 0;
  const heightRef = useRef(initialHeld && estHeight ? estHeight : 0);
  /* Mounting out of a stub is a remount — `data-remount` skips the rise
     replay — and a born-held row counts as held from the start. */
  const wasHeldRef = useRef(initialHeld);
  const [held, setHeld] = useState(initialHeld);
  const [remounted, setRemounted] = useState(false);
  /* #570: the port's pin — a stub→real commit swaps the estimate for the
     real height, moving the bottom the pin sits on. `wasStub` tracks the
     held→real edge for the layout effect below. */
  const pin = useContext(ConversationPin);
  const wasStub = useRef(initialHeld);
  /* First-commit materialization stamps the pin's hydration wake — the
     mount wave's clamp noise is quarantined the same way a swap's is. */
  const mountedRef = useRef(false);
  /* First hydration only: ?stubHydrateMs= models the CI-slow mount a
     born-stub pays once; measured re-mounts stay instant. */
  const hydratedRef = useRef(false);
  const hydrateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /* #512: while a find chord's ~10 s window runs, every held row mounts so
     browser find-in-page can match its text; the window lapsing re-arms
     the observer path and off-screen rows re-stub. */
  const findOpen = useFindUnstub(lazy);
  const lazyOn = lazy && !findOpen;

  useEffect(() => {
    const unhold = () => {
      hydratedRef.current = true;
      if (wasHeldRef.current) {
        wasHeldRef.current = false;
        setRemounted(true);
      }
      setHeld(false);
    };
    if (!lazyOn || keep || typeof IntersectionObserver === "undefined") {
      unhold();
      return;
    }
    const el = ref.current;
    if (!el) return;
    /* #554: notifications already in flight when the find session flips
       lazyOn off can still land after disconnect and re-stub a row — find
       would then miss text inside it for the whole session. */
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        for (const en of entries) {
          if (en.isIntersecting) {
            /* ?stubHydrateMs= defers a born-stub's FIRST un-hold — the
               CI-slow hydration the pin fix is proved against. */
            if (STUB_HYDRATE_MS > 0 && initialHeld && !hydratedRef.current) {
              if (hydrateTimer.current === undefined)
                hydrateTimer.current = setTimeout(() => {
                  hydrateTimer.current = undefined;
                  unhold();
                }, STUB_HYDRATE_MS);
            } else {
              unhold();
            }
          } else {
            if (hydrateTimer.current !== undefined) {
              clearTimeout(hydrateTimer.current);
              hydrateTimer.current = undefined;
            }
            /* Only a laid-out row may hold — a 0-height stub would let the
               scroll extent collapse. #537: keep the stub's height EXACT —
               offsetHeight rounds to whole pixels while real rows land
               fractionally (~±0.3 px each); across ~120 rows the rounding
               sums to a real scrollHeight delta whose resize re-arms
               stick-to-bottom's bottom pin and slides the reader's place
               by ~a row when the find window lapses. */
            const h = el.getBoundingClientRect().height;
            if (h) {
              heightRef.current = h;
              wasHeldRef.current = true;
              setHeld(true);
            }
          }
        }
      },
      /* #570: the pre-mount band only reaches through the clip that
         produces it. With the implicit viewport root the margin expands
         the window's bounds while the scroller's own clip applies raw,
         so a row just below the port edge never intersects and never
         mounts (ac-570's scroll-to-top left the early turns held). Root
         the observer at the nearest scrollable ancestor — the port
         itself, which sits INSIDE the role="log" wrapper — and the
         ±LAZY_MARGIN band works as tuned. */
      {
        root: (() => {
          for (let a = el.parentElement; a; a = a.parentElement) {
            const oy = getComputedStyle(a).overflowY;
            if (oy === "auto" || oy === "scroll") return a;
          }
          return null;
        })(),
        rootMargin: `${LAZY_MARGIN} 0px`,
      },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      if (hydrateTimer.current !== undefined) {
        clearTimeout(hydrateTimer.current);
        hydrateTimer.current = undefined;
      }
    };
  }, [lazyOn, keep]);

  /* #570: a stub→real commit swaps the estimate for the measured height —
   * the bottom edge the pin is glued to just moved. Mark the hydration
   * wake on the pin (the escape guard quarantines its scroll noise) and,
   * while the reader hasn't escaped, re-pin to the MEASURED bottom in
   * this commit (before paint): the library's smooth chase crawls frames
   * behind a hydration wave, and a mid-chase layout-clamp scroll event
   * can kill the library pin outright on a slow box, stranding the port
   * above the real bottom (CI: ac-570's open pin). `escaped` is the
   * guard's own reader-intent flag — a clamp-tripped `escapedFromLock`
   * gets cleared here so the lock keeps tracking the measured bottom. */
  useLayoutEffect(() => {
    const swapped = wasStub.current && !held;
    /* A row's first commit is materialization too — the mount wave's
       clamp noise is the same noise the hydration wake exists to
       quarantine, and the open pin's measured-bottom re-pin rides the
       same commits. */
    const firstCommit = !mountedRef.current;
    mountedRef.current = true;
    wasStub.current = held;
    if ((!swapped && !firstCommit) || !pin) return;
    /* Record this commit's wake: the hydration clock (un-attributed
       up-scrolls are quarantined while it runs), the new layout max
       (the next clamp event's landing is fingerprinted against it),
       and the guard's re-pin chain. */
    pin.hydratedAt.v = performance.now();
    pin.noteMax?.();
    pin.armReinstate?.();
    /* The reader (guard-escaped) or a find window (top-edge hold owns
       the port) stands down the re-pin. A pin the clamp already killed
       is revived only when the port still sits on a clamp landing —
       a real scroll position is never touched. */
    if (pin.escaped.v || findAnchorActive(pin.state)) return;
    if (pin.state.isAtBottom || pin.isClampTop?.()) pin.repin();
  });

  return (
    <div
      ref={ref}
      data-msg={msgId}
      className={className}
      data-remount={remounted || undefined}
      data-lazy={(lazy && !keep) || undefined}
    >
      {held ? (
        <div style={{ height: heightRef.current }} aria-hidden data-held-stub>
          {kind === "agent" ? (
            <div data-agentturn>{settled && <div data-turnsettled />}</div>
          ) : kind === "note" ? (
            <div data-sysnote />
          ) : (
            <div data-userturn />
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export interface TurnRowProps {
  /** panel = the DM/thread side panel chrome; focus = the Focus view. */
  frame: "panel" | "focus";
  r: Reply;
  i: number;
  /** This row is the last employee turn (it gets the hover Retry). */
  lastTurn: boolean;
  /** This row is the last row of the list (ReplyCards' `last`). */
  lastRow: boolean;
  flashed: boolean;
  /** Long thread: let far-off-screen rows hold as stubs. */
  lazy: boolean;
  /** #570: this row sits above the open tail — mount it as an
      estimated-height stub (`estHeight`) instead of mounting then
      stubbing. */
  startHeld?: boolean;
  estHeight?: number;
  /** This row is the scrollTo target — it must exist when scrolled to. */
  scrollTarget: boolean;
  running: boolean;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  work: Work | null;
  repo?: string;
  models?: ModelOption[];
  /** Focus only: the session's open PR — its card rides the turn that
      ran `gh pr create`. */
  pr?: PullRequest | null;
  prAuthor?: string;
  rewindWarning?: string;
  /** #558: the id of the card the keyboard answers — it carries the
      ↵/⌫ hint so the shortcut's target is visible. */
  keyTarget?: string;
  acts: MutableRefObject<TurnActs>;
}

function TurnRowImpl({
  frame,
  r,
  i,
  lastTurn,
  lastRow,
  flashed,
  lazy,
  startHeld,
  estHeight,
  scrollTarget,
  running,
  emp,
  human,
  resolved,
  work,
  repo,
  models,
  pr,
  prAuthor,
  rewindWarning,
  keyTarget,
  acts,
}: TurnRowProps) {
  /* Handlers call through `acts.current` at EVENT time — the ref
     indirection only delivers the latest closures when reads are lazy.
     Destructured here they bind whatever the view's render held when this
     row last rendered (a draft typed just before a rewind reached
     rewindTo as "" — #578). */
  const onRetry =
    acts.current.onRetry && ((id: string) => acts.current.onRetry?.(id));
  const onOpen =
    acts.current.onOpen && ((t: WbTab) => acts.current.onOpen?.(t));
  const onOpenSession =
    acts.current.onOpenSession &&
    ((employeeId: string, session: string) =>
      acts.current.onOpenSession?.(employeeId, session));
  const onPlan =
    acts.current.onPlan &&
    ((a: PlanAction, planId: string) => acts.current.onPlan?.(a, planId));
  const onRewind =
    acts.current.onRewind && ((id: string) => acts.current.onRewind?.(id));
  const setResolved =
    acts.current.setResolved &&
    ((r: Record<string, string>) => acts.current.setResolved?.(r));
  const onStart = acts.current.onStart && (() => acts.current.onStart?.());
  const onAnswer =
    acts.current.onAnswer &&
    ((q: QuestionAsk, a: QuestionAnswer) => acts.current.onAnswer?.(q, a));
  const onCancel =
    acts.current.onCancel && ((q: QuestionAsk) => acts.current.onCancel?.(q));
  const cls = cn(
    "transition-colors duration-500",
    frame === "focus" && "rounded-lg",
    flashed && "bg-amber-100 dark:bg-amber-900/40",
  );
  /* #585 AC-1: a LilOS system note is centred between hairlines — never
     the user's right-aligned bubble and never an agent card. `data-sysnote`
     is the spec anchor; deduped notes never reach the row at all. */
  if (r.system) {
    return (
      <LazyShell
        msgId={r.id}
        className={cls}
        lazy={lazy}
        keep={scrollTarget || flashed}
        kind="note"
        settled
      >
        <div data-sysnote className="flex items-center gap-2 px-3 py-1 sm:px-5">
          <span className="h-px flex-1 bg-border" />
          <span className="text-center text-muted-foreground text-xs">
            {/* #585: `tool …` spans render as code chips, like the
                assistant's text — never literal backticks. */}
            <InlineCodeText text={r.text} />
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </LazyShell>
    );
  }
  if (emp(r.from)) {
    return (
      <LazyShell
        msgId={r.id}
        className={cls}
        lazy={lazy}
        /* A turn row whose phase isn't terminal is still being written:
           `streaming` only covers the text phase, and `live` drops when the
           conversation isn't active — so a non-terminal turn must never
           hold (a stub would freeze partial height and fake the marker).
           `flashed` keeps the jump target real through the whole flash
           window: `scrollTo` clears the moment the jump lands, but stubs
           around it keep hydrating and pushing the row out of view — a
           re-hold would drop the flashed anchor's content mid-wave. */
        keep={scrollTarget || flashed || (!!r.turnId && !TERMINAL.has(r.phase))}
        startHeld={startHeld}
        estHeight={estHeight}
        kind="agent"
        settled={isSettled(r)}
      >
        {frame === "panel" ? (
          <div className="group px-3 py-2 hover:bg-muted/40 sm:px-5">
            <AgentTurn
              r={r}
              emp={emp}
              human={human}
              last={lastTurn}
              onRetry={onRetry}
              models={models}
              onOpenSession={onOpenSession}
              onPlan={onPlan}
              onOpen={onOpen}
              keyTarget={keyTarget}
              cards={
                <ReplyCards
                  r={r}
                  i={i}
                  last={lastRow}
                  work={work}
                  repo={repo}
                  emp={emp}
                  human={human}
                  resolved={resolved}
                  setResolved={setResolved}
                  onStart={onStart}
                  onAnswer={onAnswer}
                  onCancel={onCancel}
                  keyTarget={keyTarget}
                />
              }
            />
          </div>
        ) : (
          <AgentTurn
            r={r}
            emp={emp}
            human={human}
            last={lastTurn}
            onRetry={onRetry}
            models={models}
            onOpen={onOpen}
            onOpenSession={onOpenSession}
            onPlan={onPlan}
            keyTarget={keyTarget}
            cards={
              <>
                <ReplyCards
                  r={r}
                  i={i}
                  last={lastRow}
                  work={work}
                  repo={repo}
                  emp={emp}
                  human={human}
                  resolved={resolved}
                  setResolved={setResolved}
                  onStart={onStart}
                  onAnswer={onAnswer}
                  onCancel={onCancel}
                  keyTarget={keyTarget}
                />
                {pr &&
                  !r.live &&
                  r.steps?.some((s) =>
                    String(s.input.command ?? "").startsWith("gh pr create"),
                  ) && (
                    <PrCard
                      pr={pr}
                      author={prAuthor ?? pr.author}
                      onOpen={() => onOpen?.("pr")}
                    />
                  )}
              </>
            }
          />
        )}
      </LazyShell>
    );
  }
  const rewind =
    onRewind && r.id && human(r.from) ? (
      <RewindHover
        running={running}
        warning={rewindWarning}
        onRewind={() => onRewind(r.id ?? "")}
      />
    ) : null;
  /* #550: `from === ""` is the relay's system-note author
     (`authorKind: "system"` maps to it in mapping.ts) — a muted note
     line in both frames, never a user-style bubble and never an
     empty-name message row. */
  const sysNote =
    r.from === "" ? (
      <div
        data-sysnote
        className={cn(
          "w-fit max-w-full rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs",
          frame === "panel" && "mx-3 my-0.5 sm:mx-5",
        )}
      >
        {r.text}
      </div>
    ) : null;
  return (
    <LazyShell
      msgId={r.id}
      /* Focus rows anchor the hover affordance to the whole bubble row —
         `group`/`relative` live here; the panel's Row already carries both. */
      className={cn(cls, frame === "focus" && rewind && "group relative")}
      lazy={lazy}
      keep={scrollTarget || flashed}
      startHeld={startHeld}
      estHeight={estHeight}
      kind={r.from === "" ? "note" : "user"}
      settled={false}
    >
      {frame === "panel"
        ? (sysNote ?? (
            <Row from={r.from} emp={emp} human={human}>
              <Who id={r.from} time={r.time} emp={emp} human={human} />
              <Body text={r.text} />
              {r.attachments && <AttachmentChips files={r.attachments} />}
              {rewind}
            </Row>
          ))
        : (sysNote ?? (
            <>
              <UserTurn
                from={r.from}
                time={r.time}
                text={r.text}
                human={human}
                attachments={r.attachments}
              />
              {rewind}
            </>
          ))}
    </LazyShell>
  );
}

/* Shallow field compare for the per-render records (`resolved`, `work`) —
   they rebuild wholesale each render but rarely change value. */
const shallowRecord = <T,>(
  a: T | null | undefined,
  b: T | null | undefined,
) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
    )
  );
};

const sameRow = (a: TurnRowProps, b: TurnRowProps): boolean =>
  a.r === b.r &&
  a.i === b.i &&
  a.lastTurn === b.lastTurn &&
  a.lastRow === b.lastRow &&
  a.flashed === b.flashed &&
  a.lazy === b.lazy &&
  a.startHeld === b.startHeld &&
  a.estHeight === b.estHeight &&
  a.scrollTarget === b.scrollTarget &&
  /* `running` only feeds the RewindHover on user rows — an employee
     turn must not re-render when the composer flips running. */
  (a.emp(a.r.from) !== undefined || a.running === b.running) &&
  a.emp === b.emp &&
  a.human === b.human &&
  shallowRecord(a.resolved, b.resolved) &&
  shallowRecord(a.work, b.work) &&
  a.repo === b.repo &&
  a.models === b.models &&
  a.pr === b.pr &&
  a.prAuthor === b.prAuthor &&
  a.rewindWarning === b.rewindWarning &&
  a.keyTarget === b.keyTarget &&
  a.acts === b.acts;

export const TurnRow = memo(TurnRowImpl, sameRow);
