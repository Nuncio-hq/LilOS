import { Undo2Icon } from "lucide-react";
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "../components/ai-elements/checkpoint";
import { Button } from "../components/ui/button";
import { Body, Row, Who } from "../feed/row";
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
import { useFindUnstub } from "./find-unstub";
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
    return (
      46 + estLines(r.text, cpl) * 20 + (r.attachments?.length ? 34 : 0)
    );
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

/* #134: the "Rewind to here" checkpoint above each user message (moved out
   of thread-view so both frames + this file share it). A shared folder
   (`warning`) turns the click into an inline confirm; a running turn greys
   it out (AC-5). */
export function RewindCheckpoint({
  running,
  warning,
  onRewind,
}: {
  running: boolean;
  warning?: string;
  onRewind: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming && warning) {
    return (
      <div className="mx-3 my-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 sm:mx-5">
        <div className="mb-1.5 text-amber-700 text-xs dark:text-amber-300">
          {warning}
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" onClick={onRewind} data-rewind-confirm>
            Rewind anyway
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Checkpoint className="mx-3 my-0.5 text-xs sm:mx-5">
      <CheckpointIcon className="size-3.5" />
      <span title={running ? "Stop the running turn first" : undefined}>
        <CheckpointTrigger
          size="xs"
          disabled={running}
          tooltip={
            running
              ? "Stop the running turn first"
              : "Undo files + conversation back to before this message"
          }
          onClick={() => (warning ? setConfirming(true) : onRewind())}
          data-rewind
        >
          <Undo2Icon className="size-3" />
          Rewind to here
        </CheckpointTrigger>
      </span>
    </Checkpoint>
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
  kind: "agent" | "user";
  settled: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initialHeld =
    lazy && !keep && startHeld && (estHeight ?? 0) > 0;
  const heightRef = useRef(initialHeld && estHeight ? estHeight : 0);
  /* Mounting out of a stub is a remount — `data-remount` skips the rise
     replay — and a born-held row counts as held from the start. */
  const wasHeldRef = useRef(initialHeld);
  const [held, setHeld] = useState(initialHeld);
  const [remounted, setRemounted] = useState(false);
  /* #512: while a find chord's ~10 s window runs, every held row mounts so
     browser find-in-page can match its text; the window lapsing re-arms
     the observer path and off-screen rows re-stub. */
  const findOpen = useFindUnstub(lazy);
  const lazyOn = lazy && !findOpen;

  useEffect(() => {
    if (!lazyOn || keep || typeof IntersectionObserver === "undefined") {
      if (wasHeldRef.current) {
        wasHeldRef.current = false;
        setRemounted(true);
      }
      setHeld(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            if (wasHeldRef.current) {
              wasHeldRef.current = false;
              setRemounted(true);
            }
            setHeld(false);
          } else {
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
      { rootMargin: `${LAZY_MARGIN} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazyOn, keep]);

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
  acts,
}: TurnRowProps) {
  const {
    onRetry,
    onOpen,
    onOpenSession,
    onPlan,
    onRewind,
    setResolved,
    onStart,
    onAnswer,
    onCancel,
  } = acts.current;
  const cls = cn(
    "transition-colors duration-500",
    frame === "focus" && "rounded-lg",
    flashed && "bg-amber-100 dark:bg-amber-900/40",
  );
  if (emp(r.from)) {
    return (
      <LazyShell
        msgId={r.id}
        className={cls}
        lazy={lazy}
        /* A turn row whose phase isn't terminal is still being written:
           `streaming` only covers the text phase, and `live` drops when the
           conversation isn't active — so a non-terminal turn must never
           hold (a stub would freeze partial height and fake the marker). */
        keep={scrollTarget || (!!r.turnId && !TERMINAL.has(r.phase))}
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
  const checkpoint =
    onRewind && r.id && human(r.from) ? (
      <RewindCheckpoint
        running={running}
        warning={rewindWarning}
        onRewind={() => onRewind(r.id ?? "")}
      />
    ) : null;
  const shell = (
    <LazyShell
      msgId={r.id}
      className={cls}
      lazy={lazy}
      keep={scrollTarget}
      startHeld={startHeld}
      estHeight={estHeight}
      kind="user"
      settled={false}
    >
      {frame === "panel" ? (
        <>
          {checkpoint}
          <Row from={r.from} emp={emp} human={human}>
            <Who id={r.from} time={r.time} emp={emp} human={human} />
            <Body text={r.text} />
            {r.attachments && <AttachmentChips files={r.attachments} />}
          </Row>
        </>
      ) : (
        <UserTurn
          from={r.from}
          time={r.time}
          text={r.text}
          human={human}
          attachments={r.attachments}
        />
      )}
    </LazyShell>
  );
  /* The panel keeps the checkpoint inside the row's data-msg block; Focus
     renders it as a sibling above it (its own spacing). */
  return frame === "panel" ? (
    shell
  ) : (
    <>
      {checkpoint}
      {shell}
    </>
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
  /* `running` only feeds the RewindCheckpoint on user rows — an employee
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
  a.acts === b.acts;

export const TurnRow = memo(TurnRowImpl, sameRow);
