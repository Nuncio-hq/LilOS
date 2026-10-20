import type {
  AppMessage,
  Conversation,
  ConversationSummary,
} from "@lilos/contracts/app";
import type { Msg } from "@lilos/ui/types";
import { useMemo } from "react";
import { attachmentUrls } from "../lib/attachments";
import { FoldCache, type FoldInputs } from "../lib/conv-fold";
import { cwdInfo } from "../lib/folders";
import { useAtom } from "../lib/hooks";
import {
  asks as asksAtom,
  relay,
  sessionFeedAttached,
  sessionModels,
  sessionWatched,
} from "../lib/runtime";
import { EMPTY_MESSAGES, NO_ASKS, NO_MSGS } from "./empties";
import { boundModelFor, foldInputsFor } from "./fold-inputs";
import { useThreadHistory } from "./use-thread-history";

/**
 * #427: the fold's inputs, sliced per conversation once per render. The
 * slices keep element identity — relay rows are replaced immutably — so the
 * cache re-folds only the conversation a change belongs to. One pass folds
 * `convs` (the DM feed's rows, or just the open thread); the open
 * conversation's thread extras then ride the same cache entry.
 *
 * The open conversation reads its whole fetched history (`pool`), every
 * other one the channel window.
 */
export function useConvFolds(a: {
  employeeId: string;
  channelId: string | undefined;
  /** The open conversation, if any. */
  conversationId: string | undefined;
  /** The conversations to fold this pass. */
  convs: Conversation[];
}) {
  const { employeeId, channelId, conversationId, convs } = a;
  const messages: AppMessage[] = useAtom(
    channelId ? relay.channelMessages(channelId) : EMPTY_MESSAGES,
  ).messages;
  const summaries = useAtom(relay.conversationSummaries);
  const allAsks = useAtom(asksAtom);
  const models = useAtom(sessionModels);
  const feedAttached = useAtom(sessionFeedAttached);
  const watched = useAtom(sessionWatched);
  const attachUrls = useAtom(attachmentUrls);
  const employees = useAtom(relay.employees);
  const cwdBranches = useAtom(cwdInfo);
  const history = useThreadHistory(channelId, conversationId, messages);
  const { pool, drops, rewinds } = history;

  const summaryByConv = useMemo(
    () => new Map(summaries.map((s) => [s.conversation.id, s])),
    [summaries],
  );
  const msgById = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages],
  );
  const asksByConv = useMemo(() => {
    const m = new Map<string, typeof allAsks>();
    for (const x of allAsks) {
      const arr = m.get(x.conversationId);
      if (arr) arr.push(x);
      else m.set(x.conversationId, [x]);
    }
    return m;
  }, [allAsks]);
  const msgsByConv = useMemo(() => {
    const m = new Map<string, AppMessage[]>();
    for (const msg of messages) {
      if (!msg.conversationId) continue;
      /* #578: rows a pending rewind hid stay out of every conv's fold too
         — the feed preview must not show what the thread doesn't. */
      if (drops[msg.conversationId]?.ids.has(msg.id)) continue;
      const arr = m.get(msg.conversationId);
      if (arr) arr.push(msg);
      else m.set(msg.conversationId, [msg]);
    }
    /* The open thread's fold reads the full fetched pool, not the channel
       window — same rule the per-conv slices used to apply inline. */
    if (conversationId) m.set(conversationId, pool);
    return m;
  }, [messages, pool, conversationId, drops]);

  const summaryOf = (conv: Conversation): ConversationSummary | undefined =>
    summaryByConv.get(conv.id);

  const inputs = (conv: Conversation): FoldInputs => {
    const summary = summaryByConv.get(conv.id);
    const drop = drops[conv.id];
    return foldInputsFor({
      conv,
      model: conv.engineRef ? models[conv.engineRef] : undefined,
      /* #467: the fold keys on the BOUND model too — without it the cache
         would keep serving the "pending" fold after the feed attaches and
         the held-back engine replies would never appear. */
      bound: boundModelFor(conv, models, feedAttached, watched),
      msgs: msgsByConv.get(conv.id) ?? NO_MSGS,
      asks: asksByConv.get(conv.id) ?? NO_ASKS,
      rewoundEvent: rewinds[conv.id],
      /* The conv's rewound ids/texts (#134) join the event's removedIds
         inside the fold — the same merged view rewoundInfo used to hand
         mergeTurns. Open conv: fetch-history sets + the pending drop (#578);
         other convs: their drops alone. */
      localRewound:
        conv.id === conversationId
          ? history.localRewound
          : drop
            ? { ids: drop.ids, texts: drop.texts }
            : undefined,
      summary,
      root: summary?.root ?? msgById.get(conv.rootMessageId),
      attachUrls,
      employees,
      cwdInfo: cwdBranches,
      employeeId,
    });
  };

  const folds = useMemo(() => new FoldCache(), []);
  folds.reset();
  const feed: Msg[] = [];
  for (const conv of convs) {
    const f = folds.for(inputs(conv));
    if (f.msg) feed.push(f.msg);
  }
  folds.sweep();

  return {
    messages,
    summaries,
    models,
    asks: asksByConv,
    pool,
    historyFailed: history.failed,
    retryHistory: history.retry,
    drops,
    cache: folds,
    inputs,
    summaryOf,
    feed,
  };
}

export type ConvFolds = ReturnType<typeof useConvFolds>;
