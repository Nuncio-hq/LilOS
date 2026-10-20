import type { AppMessage } from "@lilos/contracts/app";
import { useEffect, useMemo, useState } from "react";
import { loadThreadHistory } from "../lib/actions";
import { ensureAttachments } from "../lib/attachments";
import { useAtom } from "../lib/hooks";
import { rewindDrops } from "../lib/rewind";
import { relay } from "../lib/runtime";

const NO_IDS: ReadonlySet<string> = new Set();
interface Loaded {
  /** The conversation this fetch belongs to — a stale one reads as empty. */
  id?: string;
  msgs: AppMessage[];
  rewoundIds: ReadonlySet<string>;
  rewoundTexts: ReadonlySet<string>;
  failed: boolean;
}
const NOTHING: Loaded = {
  msgs: [],
  rewoundIds: NO_IDS,
  rewoundTexts: NO_IDS,
  failed: false,
};

/**
 * The open thread needs its whole visible history, not just the channel
 * window (#28 AC-2): page messages.list scoped to the conversation. A failed
 * fetch used to swallow silently and the thread just looked shorter — #423
 * AC-2 surfaces a retryable notice instead.
 *
 * Returns the merged pool (fetched history + live arrivals), the merged
 * rewound-row suppression sets (+ the atoms they came from, for the fold),
 * and the fetch's failure + retry.
 */
export function useThreadHistory(
  channelId: string | undefined,
  conversationId: string | undefined,
  messages: AppMessage[],
) {
  const rewinds = useAtom(relay.rewinds);
  const drops = useAtom(rewindDrops);
  const [loaded, setLoaded] = useState<Loaded>(NOTHING);
  /* Retry bumps this counter — the effect re-runs the same fetch. */
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on Retry (#423 AC-2).
  useEffect(() => {
    setLoaded(NOTHING);
    if (!conversationId || !channelId) return;
    let dead = false;
    void loadThreadHistory(
      (method, params) => relay.request(method, params),
      channelId,
      conversationId,
    )
      .then((r) => {
        if (dead) return;
        setLoaded({
          id: conversationId,
          msgs: r.messages,
          rewoundIds: r.rewoundIds,
          rewoundTexts: r.rewoundTexts,
          failed: false,
        });
      })
      .catch(() => {
        if (!dead) setLoaded({ ...NOTHING, id: conversationId, failed: true });
      });
    return () => {
      dead = true;
    };
  }, [conversationId, channelId, attempt]);
  const cur = loaded.id === conversationId ? loaded : NOTHING;
  const threadMsgs = cur.msgs;

  /* Fetched history + live arrivals, deduped by id. Everything at/after the
     latest rewind point is dropped — the live atoms already lost it, this
     drops the fetched copy too (#134). */
  const pool = useMemo(() => {
    const rewoundFrom = conversationId
      ? rewinds[conversationId]?.fromSeq
      : undefined;
    /* #578: the visual rewind — rows hide the moment Rewind clicks, before
       the commit fires (or doesn't, on Undo). The seq rule applies to the
       fetched pool exactly like a committed rewind; the live `messages`
       store is filtered by id only so a later rewind note (seq above the
       mark) still shows. */
    const drop = conversationId ? drops[conversationId] : undefined;
    const seen = new Set<string>();
    const out: AppMessage[] = [];
    /* `threadMsgs` is a fetch-time snapshot: a rewind landing between the
       fetch and now leaves its tail rows unmarked — drop them by seq. The
       rewind note and later messages only arrive through `messages` (the
       `conversation.rewound` event already pruned that store), so the seq
       rule must not touch that source or it would hide the note.
       Live rows merge FIRST: a flag flip (`dropped`/`removed`, #315
       `message.changed`) arrives only through `messages`, and the stale
       fetch copy of the same row must never outrank it. */
    for (const m of messages) {
      if (m.conversationId !== conversationId || seen.has(m.id) || m.rewound)
        continue;
      if (drop?.ids.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    for (const m of threadMsgs) {
      if (m.conversationId !== conversationId || seen.has(m.id) || m.rewound)
        continue;
      const dropAt = Math.min(
        rewoundFrom ?? Number.MAX_SAFE_INTEGER,
        drop?.fromSeq ?? Number.MAX_SAFE_INTEGER,
      );
      if (m.seq >= dropAt) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [threadMsgs, messages, conversationId, rewinds, drops]);

  /* The conv's merged suppression sets — fetch-history ids/texts (#134) ∪
     the pending/committed drop (#578). Memoized: the fold cache keys on set
     identity, so a fresh union every render would refold every render. */
  const localRewound = useMemo(() => {
    const d = conversationId ? drops[conversationId] : undefined;
    const ids = new Set([...cur.rewoundIds, ...(d?.ids ?? [])]);
    const texts = new Set([...cur.rewoundTexts, ...(d?.texts ?? [])]);
    return ids.size || texts.size ? { ids, texts } : undefined;
  }, [cur.rewoundIds, cur.rewoundTexts, drops, conversationId]);

  /* Attachment blobs behind every visible ref — the channel window and the
     fetched thread (AC-3). */
  useEffect(() => {
    ensureAttachments(
      [...messages, ...threadMsgs].flatMap((m) => m.attachments ?? []),
    );
  }, [messages, threadMsgs]);

  return {
    pool,
    localRewound,
    rewinds,
    drops,
    failed: cur.failed,
    retry: () => setAttempt((n) => n + 1),
  };
}
