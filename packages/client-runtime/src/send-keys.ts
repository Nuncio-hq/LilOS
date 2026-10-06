/**
 * Exactly-once send keys for retried app-wire writes (#552). The key
 * belongs to the send's draft, not the tap: a request that may already
 * have landed (the relay stored it but the response died with the socket)
 * must repeat under the SAME key — the relay's `(channelId, dedupeKey)`
 * slot then answers the stored write instead of appending a second row
 * and a second turn.
 *
 * `sendKeyFor` binds one key per (scope, draft text): an unchanged resend
 * repeats the first attempt's key, edited text mints fresh, and
 * `sendKeyDone` frees the slot once a send resolves so a later deliberate
 * re-post of the same text is a new send. Bindings live in memory — as do
 * mobile drafts — so they vanish together; web composer drafts persist
 * theirs alongside the draft text instead (packages/ui `draftSendKey`).
 */
const pending = new Map<string, string>();

const slot = (scope: string, text: string) => `${scope}${text}`;

/** A fresh user-send key — the `u-` namespace keeps app sends out of the
 *  relay's internal `sys:`/`no-folder:` slots. */
export const newSendKey = (): string =>
  `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The key this send attempt must carry — its own on the first try, the
 *  original attempt's on every resend of the same draft. */
export function sendKeyFor(scope: string, text: string): string {
  const id = slot(scope, text);
  const hit = pending.get(id);
  if (hit) return hit;
  const key = newSendKey();
  pending.set(id, key);
  return key;
}

/** The send resolved — drop the binding so re-posting the same text is new. */
export function sendKeyDone(scope: string, text: string): void {
  pending.delete(slot(scope, text));
}
