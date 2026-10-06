import type {
  AppMessage,
  ConversationsRewindResult,
} from "@lilos/contracts/app";
import { atom } from "nanostores";
import { describeActionError } from "./actions";
import { relay } from "./runtime";
import { clearToast, say, sayAction, sayError } from "./toast";

/* #578 rewind-with-Undo. Clicking Rewind applies the visual part at once —
   rows at/after the picked message hide, the target reseeds the composer —
   while a 10 s toast offers Undo. Only when the window closes does the real
   `conversations.rewind` RPC commit (engine session + file checkpoints in
   one step); Undo or a commit failure restores everything because nothing
   destructive happened yet. The module atoms survive the page unmounting —
   the timer and the hidden-row sets live here, not in component state. */

/** Rows hidden by a rewind for one conversation. `ids`/`texts` also
    suppress the engine-feed turns the dropped rows would resurrect
    through — the same merged view the committed event's `removedIds`
    used to feed. */
export interface RewoundDrop {
  /** Relay seq of the rewind target — rows at/after it stay hidden. */
  fromSeq: number;
  ids: ReadonlySet<string>;
  texts: ReadonlySet<string>;
}

/** Pending + committed drops per conversation. A committed rewind keeps its
    drop: the relay event prunes the stores for real, but fetched history
    and pre-event arrivals still need the filter. Cleared on Undo / commit
    failure — and when the open conversation changes (page-scoped). */
export const rewindDrops = atom<Record<string, RewoundDrop>>({});

/** The rewind inside its 10 s Undo window. One at a time — a second click
    or a send in the same conversation commits the first one first. */
export interface PendingRewind {
  conversationId: string;
  messageId: string;
  /** Exactly what this click hid — Undo/rollback subtracts just this. */
  drop: RewoundDrop;
  /** Composer draft before the target's text replaced it — Undo puts it
      back (the relay has no record of it). */
  draftBefore: string;
}
export const pendingRewind = atom<PendingRewind | null>(null);

/** AC-3 banner: a transport without `rewind` (ACP) still restored the files
    and offers "Start a new session from here". Module-level because the
    commit lands after the window — possibly after the page remounted. */
export const filesOnlyBanner = atom<{
  conversationId: string;
  target: AppMessage;
  filesRestored: boolean;
} | null>(null);

/** One-shot "put the composer back" for the mounted page: Undo (or a failed
    commit) restores the pre-rewind draft and drops the reseeded attachment
    chips. The page consumes and clears it. */
export const rewindUndone = atom<{
  conversationId: string;
  draftBefore: string;
} | null>(null);

/** Undo window in ms — a page.clock fast-forward target in e2e. */
export const REWIND_UNDO_MS = 10_000;

let commitTimer: ReturnType<typeof setTimeout> | undefined;

function dropFor(conversationId: string, drop: RewoundDrop): void {
  const prev = rewindDrops.get()[conversationId];
  rewindDrops.set({
    ...rewindDrops.get(),
    [conversationId]: {
      fromSeq: Math.min(prev?.fromSeq ?? drop.fromSeq, drop.fromSeq),
      ids: new Set([...(prev?.ids ?? []), ...drop.ids]),
      texts: new Set([...(prev?.texts ?? []), ...drop.texts]),
    },
  });
}

function undropFor(conversationId: string, drop: RewoundDrop): void {
  const prev = rewindDrops.get()[conversationId];
  if (!prev) return;
  const ids = new Set([...prev.ids].filter((id) => !drop.ids.has(id)));
  const texts = new Set([...prev.texts].filter((t) => !drop.texts.has(t)));
  const map = { ...rewindDrops.get() };
  /* fromSeq is the MIN over drops — the entry goes only when nothing else
     remains hidden. */
  if (!ids.size && !texts.size) delete map[conversationId];
  else map[conversationId] = { ...prev, ids, texts };
  rewindDrops.set(map);
}

/** The real commit — fires when the Undo window closes, on a send in the
    same conversation, or when a second rewind starts. Failure lifts the
    drop and restores the draft: nothing ends up half-rewound. */
async function commitRewind(pending: PendingRewind): Promise<void> {
  pendingRewind.set(null);
  clearToast();
  try {
    const res = await relay.request<ConversationsRewindResult>(
      "conversations.rewind",
      {
        conversationId: pending.conversationId,
        messageId: pending.messageId,
      },
    );
    if (!res.engineRewound)
      filesOnlyBanner.set({
        conversationId: pending.conversationId,
        target: res.message,
        filesRestored: res.filesRestored,
      });
  } catch (e) {
    undropFor(pending.conversationId, pending.drop);
    rewindUndone.set({
      conversationId: pending.conversationId,
      draftBefore: pending.draftBefore,
    });
    sayError(describeActionError("Couldn't rewind the turn", e));
  }
}

/** Apply the visual rewind + open the Undo window. The page computes
    `drop` from its message pool and seeds the composer itself — it owns
    the mounted draft. */
export function beginRewind(
  pending: Omit<PendingRewind, "drop">,
  drop: { fromSeq: number; ids: string[]; texts: string[] },
): void {
  const full: PendingRewind = {
    ...pending,
    drop: {
      fromSeq: drop.fromSeq,
      ids: new Set(drop.ids),
      texts: new Set(drop.texts),
    },
  };
  /* A second rewind commits the pending one first — its window closes
     silently and this toast replaces it. */
  const prev = pendingRewind.get();
  if (prev) {
    if (commitTimer) clearTimeout(commitTimer);
    void commitRewind(prev);
  }
  dropFor(full.conversationId, full.drop);
  pendingRewind.set(full);
  sayAction(
    "Turn rewound — Undo brings the messages and file changes back (10 s).",
    { label: "Undo", run: undoRewind },
    REWIND_UNDO_MS,
  );
  commitTimer = setTimeout(() => void commitRewind(full), REWIND_UNDO_MS);
}

/** Undo inside the window: lift the drop, restore the draft — no RPC, the
    commit never happened. */
export function undoRewind(): void {
  const pending = pendingRewind.get();
  if (!pending) return;
  if (commitTimer) clearTimeout(commitTimer);
  pendingRewind.set(null);
  undropFor(pending.conversationId, pending.drop);
  rewindUndone.set({
    conversationId: pending.conversationId,
    draftBefore: pending.draftBefore,
  });
  clearToast();
  say("Rewind undone — the thread is back where it was.");
}

/** Commit the open window for `conversationId` now — a send must see the
    real post-rewind session, not the visual one. No-op otherwise. */
export async function flushRewind(conversationId: string): Promise<void> {
  const pending = pendingRewind.get();
  if (!pending || pending.conversationId !== conversationId) return;
  if (commitTimer) clearTimeout(commitTimer);
  await commitRewind(pending);
}
