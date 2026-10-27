import type { SessionFeedState } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  SummaryMessage,
} from "@lilos/contracts/app";
import type { TranscriptNote } from "@lilos/ui/types";
import { sameFolder } from "../lib/folders";
import { questionReceipt } from "../lib/mapping";
import { currentName } from "../lib/me";
import type { RewoundDrop } from "../lib/rewind";
import { outcomeLabel } from "./outcome";

/* Pure derivations the thread header, transcript and Rewind confirm read —
   kept out of the hook so each rule has one home. */

/** The thread's header root. #134: after a rewind TO the root the relay
    keeps the (rewound) root on the summary for list context — but the open
    thread must not show a message it just dropped. Fall back to the first
    surviving message (the "⚠ Files restored" note) instead. #578: a PENDING
    (visual, uncommitted) rewind hides the root from the pool but leaves the
    summary's `rewound` unset until the window closes — the header must
    honor the drop's ids too or the root keeps rendering as the thread header
    through the Undo window. */
export function threadRoot(
  conv: Conversation,
  pool: AppMessage[],
  listed: SummaryMessage | undefined,
  drop: RewoundDrop | undefined,
): AppMessage | SummaryMessage | undefined {
  const inPool = pool.find((m) => m.id === conv.rootMessageId);
  if (inPool) return inPool;
  const dropped = !!listed && !!drop?.ids.has(listed.id);
  return listed && !listed.rewound && !dropped ? listed : pool[0];
}

/** Visible messages are the relay's; the working transcript is the engine
    feed's. Notes carry a kind so the views pick the slot (#532):
    "unavailable" (#28) tails the transcript — the live tail can't replay;
    "trimmed" (#431) heads it — the missing history sits above the first
    entry. */
export function transcriptNoteFor(
  conv: Conversation,
  feed: SessionFeedState,
  engineState: string,
): TranscriptNote | undefined {
  if (!conv.engineRef) return undefined;
  if (!feed.synced || feed.error)
    return {
      kind: "unavailable",
      text: `Working transcript unavailable — ${
        feed.error ??
        (engineState !== "ready"
          ? "the engine is down or restarting"
          : "still syncing")
      }`,
    };
  /* #431: a capped engine log means the transcript's retained tail is all
     that exists — say so rather than letting the missing head read as a
     render gap. */
  if (feed.historyTrimmed)
    return {
      kind: "trimmed",
      text: "Earlier history was trimmed — this thread's event log is capped.",
    };
  return undefined;
}

/** askId → the receipt a resolved card shows. #553: a question ask's receipt
    names the answer — "Answered "<label>" by <name>" / "Cancelled by <name>"
    like #420's card. */
export function resolvedReceipts(asks: Ask[]): Record<string, string> {
  const out: Record<string, string> = {};
  const name = currentName();
  for (const a of asks)
    if (a.state === "resolved" && a.outcome)
      out[a.id] =
        a.request.kind === "question"
          ? questionReceipt(a, name)
          : outcomeLabel(a.outcome, name);
  return out;
}

/** #134 AC-5: another live session on the same folder → the Rewind click
    asks first (its files roll back too); the message names it. */
export function rewindWarningFor(
  conv: Conversation,
  summaries: ConversationSummary[],
  home: string | null,
): string | undefined {
  const sharer = summaries
    .map((s) => s.conversation)
    .find(
      (c) =>
        c.id !== conv.id &&
        !c.archived &&
        conv.cwd !== undefined &&
        sameFolder(c.cwd, conv.cwd, home),
    );
  if (!sharer) return undefined;
  const name =
    sharer.title ||
    summaries
      .find((s) => s.conversation.id === sharer.id)
      ?.root?.text.slice(0, 60) ||
    "another thread";
  return `This folder is shared with “${name}” — rewinding changes its files too.`;
}
