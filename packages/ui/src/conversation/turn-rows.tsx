import { type MutableRefObject, memo, type ReactNode } from "react";
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
import { LazyShell } from "./lazy-shell";
import type { PlanAction } from "./plan-card";
import { PrCard } from "./pr-card";
import type { QuestionAnswer } from "./question-card";
import { AgentTurn } from "./turns";
import { UserTurn } from "./user-turn";

/**
 * #430: one reply row, memoized so an incoming delta re-renders only the
 * row whose `Reply` changed (the incremental reducer + fold cache keep
 * every untouched reply's object identity — `r` is THE compare that
 * matters; everything else is a view input compared by identity, or
 * shallowly for the per-render `resolved`/`work` records).
 *
 * `lazy` mounts a viewport-watcher (`LazyShell`, lazy-shell.tsx): rows
 * far outside the scroll window unmount to a measured-height stub that
 * keeps the spec anchors (`data-msg`, `data-agentturn`/`data-userturn`,
 * `data-turnsettled` when settled) and the total scroll height. Engaged
 * only on long threads (`lazy` false below it), so short threads — every
 * e2e spec — always render full DOM.
 *
 * Handlers arrive through `acts`, a ref the view rewrites each render:
 * they never render by themselves, so latest-closure reads are always
 * fresh and the memo isn't broken by per-render callback identity.
 */

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

/* A note LilOS wrote into the thread, set between hairlines so it never
   reads as a message. */
function SysNote({ children }: { children: ReactNode }) {
  return (
    <div
      data-sysnote
      className="flex items-center gap-3 text-[12.5px] text-muted-foreground/70"
    >
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
      <span className="max-w-[80%] text-center">{children}</span>
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
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
  /* #585 AC-1: a LilOS system note is a quiet centred line between
     hairlines (the prototype's "Opening"/"Rewound" line) — never the user's
     bubble and never an agent card. `data-sysnote` is the spec anchor;
     deduped notes never reach the row at all. */
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
        <SysNote>
          {/* #585: `tool …` spans render as code chips, like the
              assistant's text — never literal backticks. */}
          <InlineCodeText text={r.text} />
        </SysNote>
      </LazyShell>
    );
  }
  if (emp(r.from)) {
    return (
      <LazyShell
        msgId={r.id}
        /* The column spaces turns 28px apart; an agent's work belongs to
           the message above it, so it sits closer (the prototype's 16px). */
        className={cn(cls, "[[data-msg]:has([data-userturn])+&]:-mt-3")}
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
                    onOpen={onOpen && (() => onOpen("pr"))}
                  />
                )}
            </>
          }
        />
      </LazyShell>
    );
  }
  /* #550: `from === ""` is the relay's system-note author
     (`authorKind: "system"` maps to it in mapping.ts) — the same quiet
     centred line, never a user-style bubble and never an empty-name row. */
  const rewind =
    onRewind && r.id && human(r.from)
      ? {
          running,
          warning: rewindWarning,
          onRewind: () => onRewind(r.id ?? ""),
        }
      : undefined;
  return (
    <LazyShell
      msgId={r.id}
      className={cls}
      lazy={lazy}
      keep={scrollTarget || flashed}
      startHeld={startHeld}
      estHeight={estHeight}
      kind={r.from === "" ? "note" : "user"}
      settled={false}
    >
      {r.from === "" ? (
        <SysNote>{r.text}</SysNote>
      ) : (
        <UserTurn
          from={r.from}
          time={r.time}
          text={r.text}
          human={human}
          attachments={r.attachments}
          rewind={rewind}
        />
      )}
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
