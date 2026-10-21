import type { MutableRefObject } from "react";
import { cn } from "../lib/utils";
import type {
  EmpFn,
  HumanFn,
  ModelOption,
  Msg,
  PullRequest,
  Thread,
  TranscriptNote,
  Work,
} from "../types";
import { TranscriptNoteRow } from "./transcript-note";
import { type TurnActs, TurnRow } from "./turn-rows";
import type { TurnWindow } from "./use-thread-frame";
import { UserTurn } from "./user-turn";

/* The conversation's rows, in the order both frames draw them: a "trimmed"
   note, the root message, every reply through the one memoized TurnRow, an
   "unavailable" note. A fragment on purpose — the rows are direct children
   of the frame's column, which spaces them. The frame supplies the column and
   what it alone adds (the thread panel's "started work" card). */
export function TurnList({
  frame,
  root,
  thread,
  emp,
  human,
  resolved,
  work,
  repo,
  models,
  pr,
  prAuthor,
  running,
  flash,
  win,
  scrollTo,
  rewindWarning,
  keyTarget,
  acts,
  onRewind,
  transcriptNote,
}: {
  frame: "panel" | "focus";
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  work: Work | null;
  repo?: string;
  models?: ModelOption[];
  /** The session's PR: its card rides the turn that ran `gh pr create`. */
  pr?: PullRequest | null;
  prAuthor?: string;
  running: boolean;
  /** The message id flashing after a jump-to-hit. */
  flash: string | null;
  win: TurnWindow;
  scrollTo?: string;
  rewindWarning?: string;
  keyTarget?: string;
  acts: MutableRefObject<TurnActs>;
  onRewind?: (messageId: string) => void;
  transcriptNote?: TranscriptNote;
}) {
  const { lazyRows, estHeights, tailStart, lastTurnIdx } = win;
  return (
    <>
      {transcriptNote?.kind === "trimmed" && (
        <TranscriptNoteRow note={transcriptNote} />
      )}
      {/* A thread an agent opened has no first message from the person: its
          header still says when it began, and a bare byline under it would
          say nothing. */}
      {(root.text || root.attachments?.length) && (
        <div
          data-msg={root.id}
          className={cn(
            "rounded-lg transition-colors duration-500",
            flash === root.id && "bg-amber-100 dark:bg-amber-900/40",
          )}
        >
          <UserTurn
            from={root.from}
            time={root.time}
            text={root.text}
            human={human}
            attachments={root.attachments}
            rewind={
              onRewind && root.id && human(root.from)
                ? {
                    running,
                    warning: rewindWarning,
                    onRewind: () => onRewind(root.id ?? ""),
                  }
                : undefined
            }
          />
        </div>
      )}
      {/* Employee turns render through the one shared AgentTurn — same DOM in
          both frames. The data-msg wrapper is the search-hit scroll/flash
          anchor (#138). #430: memoized per row — a delta re-renders only the
          turn it touched; long threads hold far-off-screen rows as stubs
          (data-msg/turnsettled anchors preserved). */}
      {thread.replies.map((r, i) => (
        <TurnRow
          key={r.turnId ?? r.id ?? i}
          frame={frame}
          r={r}
          i={i}
          lastTurn={i === lastTurnIdx}
          lastRow={i === thread.replies.length - 1}
          flashed={flash === r.id}
          lazy={lazyRows}
          startHeld={i < tailStart}
          estHeight={estHeights[i]}
          scrollTarget={scrollTo === r.id}
          running={running}
          emp={emp}
          human={human}
          resolved={resolved}
          work={work}
          repo={repo}
          models={models}
          pr={pr}
          prAuthor={prAuthor}
          rewindWarning={rewindWarning}
          keyTarget={keyTarget}
          acts={acts}
        />
      ))}
      {transcriptNote?.kind === "unavailable" && (
        <TranscriptNoteRow note={transcriptNote} />
      )}
    </>
  );
}
