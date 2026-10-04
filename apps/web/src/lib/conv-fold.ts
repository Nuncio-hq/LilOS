/**
 * #427: the DM page used to fold every conversation's relay rows + live
 * engine turns on every render — one streamed word reran the fold for ALL
 * sessions (the `waitingMessages` + `conversationReplies` + `mergeTurns` +
 * `toFeed` chain per conversation, per delta).
 *
 * `FoldCache` keys each conversation's fold on the inputs the fold reads:
 * while they compare equal it returns the previous result, so a word
 * landing in one session recomputes only that conversation. The message
 * and ask slices compare elementwise (relay rows are replaced immutably —
 * a flag flip lands as a new row object), every other input by identity:
 * the conversation/summary rows the relay swaps on update, the per-session
 * `SessionModel` a delta rebuilds, the employees/cwdInfo atoms.
 *
 * The cache is render-scoped: `reset()` before the pass, `sweep()` after,
 * and entries for conversations no longer listed are dropped.
 */
import {
  type SessionModel,
  type WaitingResult,
  waitingMessages,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import type { QueuedTrayItem } from "@lilos/ui";
import type { Msg, Reply, Workspace } from "@lilos/ui/types";
import { wsFor } from "./folders";
import { conversationReplies, mergeTurns, stripPlans, toFeed } from "./mapping";

type Inputs = readonly unknown[];

const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((x, i) => Object.is(x, b[i])));

const same = (a: Inputs, b: Inputs): boolean =>
  a.length === b.length && a.every((x, i) => sameValue(x, b[i]));

export interface FoldInputs {
  conv: Conversation;
  /** This conv's reduced engine model — a delta rebuilds only its own. */
  model: SessionModel | undefined;
  /** Conv-scoped message rows (the open thread's pool, else channel rows). */
  msgs: AppMessage[];
  /** Conv-scoped asks. */
  asks: Ask[];
  /** Latest `conversation.rewound` for this conv (#134). */
  rewoundEvent: { fromSeq: number; removedIds: string[] } | undefined;
  /** Open conv only: locally-known rewound ids + dropped answer texts. */
  localRewound?: { ids: ReadonlySet<string>; texts: ReadonlySet<string> };
  summary: ConversationSummary | undefined;
  /** The feed row's root message (summary.root or its channel row). */
  root: AppMessage | undefined;
  employees: Employee[];
  cwdInfo: Record<string, { branch: string } | null>;
  employeeId: string;
}

export interface ThreadInputs {
  /** The thread's resolved root id — filtered out like the header shows. */
  rootId: string | undefined;
  planCap: boolean;
}

export interface FeedFold {
  waiting: WaitingResult;
  /** mergeTurns output — turnIds already scoped `conv.id:` (#320). */
  replies: Reply[];
  /** toFeed row — null when the conv has no root to headline with. */
  msg: Msg | null;
  /** The conv's workspace badge — the open thread reuses it. */
  ws: Workspace | undefined;
}

export interface ThreadFold {
  replies: Reply[];
  /** ■-stopped parked sends — the not-sent tray's rows (#315). */
  notSent: AppMessage[];
  pendingItems: QueuedTrayItem[];
}

interface Entry {
  inputs: Inputs;
  feed: FeedFold;
  threadInputs?: Inputs;
  thread?: ThreadFold;
}

const inputKey = (i: FoldInputs): Inputs => [
  i.conv,
  i.model,
  i.msgs,
  i.asks,
  i.rewoundEvent,
  i.localRewound?.ids,
  i.localRewound?.texts,
  i.summary,
  i.root,
  i.employees,
  i.cwdInfo,
  i.employeeId,
];

const empRef = (employees: Employee[]) => (ref: string) =>
  employees.find((x) => x.profile === ref)?.id ?? ref;

/** #134 refs/texts a turn must not resurrect through — the merged view the
    page's per-conv rewoundInfo used to build. */
const rewoundOf = (i: FoldInputs) =>
  i.rewoundEvent || i.localRewound
    ? {
        refs: new Set([
          ...(i.rewoundEvent?.removedIds ?? []),
          ...(i.localRewound?.ids ?? []),
        ]),
        ...(i.localRewound?.texts.size ? { texts: i.localRewound.texts } : {}),
      }
    : undefined;

function computeFeed(i: FoldInputs): FeedFold {
  const waiting = waitingMessages(i.msgs, i.conv.deliveredSeq, i.model);
  /* List-row replies: real messages inside the snapshot window, padded to
     the summary's count with the answer preview on top when it isn't. */
  const want = i.summary ? i.summary.messageCount - 1 : undefined;
  const known = conversationReplies(
    i.msgs.filter(
      (m) => m.id !== i.conv.rootMessageId && !waiting.hiddenIds.has(m.id),
    ),
    i.conv.id,
  );
  let out = known;
  if (want !== undefined && known.length < want) {
    out = [...known];
    if (
      i.summary?.firstAnswer &&
      !out.some((r) => r.id === i.summary?.firstAnswer?.id)
    ) {
      const [preview] = conversationReplies([i.summary.firstAnswer], i.conv.id);
      if (preview) out.unshift(preview);
    }
    while (out.length < want)
      out.push({
        id: `history-${i.conv.id}-${out.length}`,
        from: "user",
        time: "",
        text: "",
      });
  }
  const replies = mergeTurns(
    out,
    i.model,
    i.employeeId,
    i.asks,
    rewoundOf(i),
    empRef(i.employees),
    i.conv.rootMessageId,
    i.conv.state,
  );
  for (const r of replies) if (r.turnId) r.turnId = `${i.conv.id}:${r.turnId}`;
  const ws = wsFor(i.conv.cwd, i.cwdInfo);
  return {
    waiting,
    replies,
    msg: i.root ? toFeed(i.root, i.conv, replies, ws) : null,
    ws,
  };
}

function computeThread(
  i: FoldInputs,
  t: ThreadInputs,
  waiting: WaitingResult,
): ThreadFold {
  let replies = mergeTurns(
    conversationReplies(
      i.msgs.filter(
        (m) =>
          m.id !== i.conv.rootMessageId &&
          m.id !== t.rootId &&
          !waiting.hiddenIds.has(m.id),
      ),
      i.conv.id,
    ),
    i.model,
    i.employeeId,
    i.asks,
    rewoundOf(i),
    empRef(i.employees),
    i.conv.rootMessageId,
    i.conv.state,
  );
  for (const r of replies) if (r.turnId) r.turnId = `${i.conv.id}:${r.turnId}`;
  if (!t.planCap) replies = stripPlans(replies);
  return {
    replies,
    notSent: i.msgs.filter((m) => m.dropped),
    /* An accepted-but-unlanded steer already reached the engine — its row
       still lists in the tray but Edit/Remove aren't offered (#315 AC-4). */
    pendingItems: waiting.waiting.map((w) =>
      w.removable ? w.message.text : { text: w.message.text, removable: false },
    ),
  };
}

export class FoldCache {
  private map = new Map<string, Entry>();
  private seen = new Set<string>();

  /** Call before a render pass and `sweep()` after — drops stale convs. */
  reset() {
    this.seen.clear();
  }
  sweep() {
    for (const id of this.map.keys())
      if (!this.seen.has(id)) this.map.delete(id);
  }

  /** The conversation's shared fold — cached while its inputs compare equal. */
  for(i: FoldInputs): FeedFold {
    this.seen.add(i.conv.id);
    const key = inputKey(i);
    const prev = this.map.get(i.conv.id);
    if (prev && same(prev.inputs, key)) return prev.feed;
    const feed = computeFeed(i);
    this.map.set(i.conv.id, { inputs: key, feed });
    return feed;
  }

  /** The open conversation's fold plus its thread extras — same cache
      entry, so `waiting` folds once per input change, not per call site. */
  thread(
    i: FoldInputs,
    t: ThreadInputs,
  ): { feed: FeedFold; thread: ThreadFold } {
    const feed = this.for(i);
    const e = this.map.get(i.conv.id);
    if (!e) throw new Error("FoldCache.thread: entry vanished");
    const tKey: Inputs = [t.rootId, t.planCap];
    if (!e.thread || !e.threadInputs || !same(e.threadInputs, tKey)) {
      e.threadInputs = tKey;
      e.thread = computeThread(i, t, feed.waiting);
    }
    return { feed, thread: e.thread };
  }
}
