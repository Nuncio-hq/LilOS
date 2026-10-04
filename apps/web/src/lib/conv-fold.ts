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
  type TurnModel,
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
import {
  conversationReplies,
  liveReplies,
  mergeTurns,
  stripPlans,
  toFeed,
} from "./mapping";

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
  /** This conv's reduced engine model — a delta rebuilds only its own.
      `waitingMessages` reads the raw model (steer pairing doesn't wait on
      the feed's attach watermark, #467). */
  model: SessionModel | undefined;
  /** mergeTurns' model (#467): "pending" while the session feed hasn't
      attached — engine-post rows stay held. Keyed on the fold: "pending" →
      the bound model MUST re-fold or the held replies never appear. */
  bound: SessionModel | "pending" | undefined;
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
  i.bound,
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

/* #430: identity caches. The reducer keeps a `TurnModel`'s object identity
   while a delta leaves it untouched — these WeakMaps carry that identity
   through the fold so the memoized rows see the SAME `Reply` objects.
   Keyed on the source objects, so nothing is retained past GC. */

/** AppMessage row -> its Reply (conversationReplies cache). */
const msgReplyCache = new WeakMap<AppMessage, Reply>();

/** Reply -> its plan-stripped clone (stripPlans cache). */
const strippedCache = new WeakMap<Reply, Reply>();

/** employees array -> the resolveEmployee fn for it (mergeTurns arg). */
const empRefCache = new WeakMap<Employee[], (ref: string) => string>();

const empRef = (employees: Employee[]) => {
  let fn = empRefCache.get(employees);
  if (!fn) {
    fn = (ref: string) => employees.find((x) => x.profile === ref)?.id ?? ref;
    empRefCache.set(employees, fn);
  }
  return fn;
};

/* TurnModel -> its merged reply blocks. One entry per turn, variant-keyed
   on what the block depends on beyond the turn: `liveNow` (the live turn
   carries streaming chrome the settled one doesn't) and `claimId` (the
   relay row id the claim pass stamps onto the block's last reply — the
   #138 search-anchor swap). asks / employeeId / resolveEmployee / conv are
   inputs too — when any of them moves the variants are stale. `conv` keys
   the conversation: the callers rescope `turnId` in place, so a shared
   session must never see another conversation's prefixed replies. */
interface TurnBlockEntry {
  asks: Ask[];
  emp: string;
  resFn: (ref: string) => string;
  conv: string;
  variants: Map<string, Reply[]>;
}
const turnBlockCache = new WeakMap<TurnModel, TurnBlockEntry>();

/** The `liveFor` mergeTurns hook: same replies, cached per turn so an
    incremental fold reuses the exact `Reply[]` of every untouched turn. */
const cachedLiveFor = (i: FoldInputs, resFn: (ref: string) => string) => {
  return (t: TurnModel, liveNow: boolean, claimId?: string): Reply[] => {
    let entry = turnBlockCache.get(t);
    if (
      !entry ||
      entry.asks !== i.asks ||
      entry.emp !== i.employeeId ||
      entry.resFn !== resFn ||
      entry.conv !== i.conv.id
    ) {
      entry = {
        asks: i.asks,
        emp: i.employeeId,
        resFn,
        conv: i.conv.id,
        variants: new Map(),
      };
      turnBlockCache.set(t, entry);
    }
    const key = `${liveNow ? 1 : 0}:${claimId ?? ""}`;
    let rs = entry.variants.get(key);
    if (!rs) {
      rs = liveReplies(t, i.employeeId, i.asks, resFn, liveNow);
      if (claimId !== undefined)
        rs[rs.length - 1] = { ...rs[rs.length - 1], id: claimId };
      entry.variants.set(key, rs);
    }
    return rs;
  };
};

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
    msgReplyCache,
  );
  let out = known;
  if (want !== undefined && known.length < want) {
    out = [...known];
    if (
      i.summary?.firstAnswer &&
      !out.some((r) => r.id === i.summary?.firstAnswer?.id)
    ) {
      const [preview] = conversationReplies(
        [i.summary.firstAnswer],
        i.conv.id,
        msgReplyCache,
      );
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
  const resFn = empRef(i.employees);
  const replies = mergeTurns(
    out,
    i.bound,
    i.employeeId,
    i.asks,
    rewoundOf(i),
    resFn,
    i.conv.rootMessageId,
    i.conv.state,
    cachedLiveFor(i, resFn),
  );
  /* Cached replies rescope across folds — don't double-prefix. */
  for (const r of replies)
    if (r.turnId && !r.turnId.startsWith(`${i.conv.id}:`))
      r.turnId = `${i.conv.id}:${r.turnId}`;
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
  const resFn = empRef(i.employees);
  let replies = mergeTurns(
    conversationReplies(
      i.msgs.filter(
        (m) =>
          m.id !== i.conv.rootMessageId &&
          m.id !== t.rootId &&
          !waiting.hiddenIds.has(m.id),
      ),
      i.conv.id,
      msgReplyCache,
    ),
    i.bound,
    i.employeeId,
    i.asks,
    rewoundOf(i),
    resFn,
    i.conv.rootMessageId,
    i.conv.state,
    cachedLiveFor(i, resFn),
  );
  for (const r of replies)
    if (r.turnId && !r.turnId.startsWith(`${i.conv.id}:`))
      r.turnId = `${i.conv.id}:${r.turnId}`;
  if (!t.planCap) replies = stripPlans(replies, strippedCache);
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
