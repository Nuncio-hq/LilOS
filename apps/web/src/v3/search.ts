import type { MessageSearchHit } from "@lilos/contracts/app";
import type { V3MessageHit } from "@lilos/ui";
import { describeActionError } from "../lib/actions";
import { USER_ID } from "../lib/me";
import { relay } from "../lib/runtime";
import { sayError } from "../lib/toast";
import { clockOrDate } from "./threads";

/* ⌘K's message search (#138): what was said, across every thread, archived
   ones too (the palette marks them). The relay builds the FTS expression
   from the raw text; D-#138 keeps the index to visible message text, so
   engine transcripts and tool output never match. */

/** A hit as the palette reads it. Rows that belong to no thread cannot be
    opened, so they are dropped here. */
export function messageHitOf(
  h: MessageSearchHit,
  now: number,
): V3MessageHit | undefined {
  if (!h.conversationId) return undefined;
  return {
    messageId: h.messageId,
    threadId: h.conversationId,
    // #585: a LilOS note reads "LilOS", never as you — stored notes can
    // carry the relay's "user" authorId default, so the kind decides.
    by:
      h.authorKind === "system"
        ? "system"
        : h.authorKind === "user" || h.authorId === USER_ID
          ? "you"
          : h.authorId,
    at: clockOrDate(h.createdAt, now),
    snippet: h.snippet,
  };
}

export async function searchMessages(query: string): Promise<V3MessageHit[]> {
  try {
    const res = await relay.request<{ hits: MessageSearchHit[] }>(
      "messages.search",
      { query, includeArchived: true, limit: 50 },
    );
    const now = Date.now();
    return res.hits.flatMap((h) => messageHitOf(h, now) ?? []);
  } catch (e) {
    // The palette swallows the rejection, so the toast is the only signal
    // that the search failed rather than found nothing (#423).
    sayError(describeActionError("Couldn't search messages", e));
    throw e;
  }
}
