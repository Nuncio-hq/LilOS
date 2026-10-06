import { useCallback, useState } from "react";

/* Unsent composer drafts, kept per conversation so switching views — or a
   reload / app restart — never loses typed text (issue #103). localStorage
   is a per-device convenience only: nothing here is sent to the relay or the
   engine, and every access is try/catch so blocked storage just means no
   draft, never a crash. */
const PREFIX = "lilos:composer-draft:";

/** Stable draft keys for the two composer scopes.
 *  `thread` — a conversation's reply composer (ThreadView / FocusView).
 *  `dm` — an employee's home composer (new top-level message). Keyed by
 *  employee because the relay only materializes the DM channel record on the
 *  first send — the key must be stable before that. */
export const draftKey = {
  thread: (conversationId: string) => `conv:${conversationId}`,
  dm: (employeeId: string) => `dm:${employeeId}`,
  /* #584: the Workbench's commit-message box — a Suggest answer (or typed
     text) survives a reload exactly like a composer draft (AC-2). */
  commit: (sessionId: string) => `wb-commit:${sessionId}`,
};

const storageKey = (key: string) => `${PREFIX}${key}`;

/** What a key holds: the draft text plus the send's exactly-once key
 *  (#552) — minted on the first send, kept while the text is unchanged so
 *  a failed send's resend repeats it, and cleared with the draft. Drafts
 *  written before the envelope stored the bare text — they read as
 *  `{ t: raw, k: null }`. */
interface DraftRecord {
  t: string;
  k: string | null;
}

const parseRecord = (raw: string | null): DraftRecord | undefined => {
  if (raw === null) return undefined;
  if (raw.startsWith("{")) {
    try {
      const rec = JSON.parse(raw) as { t?: unknown; k?: unknown };
      if (typeof rec.t === "string") {
        return { t: rec.t, k: typeof rec.k === "string" ? rec.k : null };
      }
    } catch {
      // not an envelope — a typed `{`-leading draft keeps its text below
    }
  }
  return { t: raw, k: null };
};

const read = (key: string): DraftRecord | undefined => {
  try {
    return parseRecord(localStorage.getItem(storageKey(key)));
  } catch {
    return undefined;
  }
};

const write = (key: string, rec: DraftRecord | undefined): void => {
  try {
    if (!rec || rec.t === "") localStorage.removeItem(storageKey(key));
    else localStorage.setItem(storageKey(key), JSON.stringify(rec));
  } catch {
    // blocked storage → drafts are simply off for this device
  }
};

/** Stored draft for `key`, or "" — never throws. */
export function getDraft(key: string): string {
  return read(key)?.t ?? "";
}

/** Write `value` for `key`; empty text removes the entry (no empty pile-up). */
export function setDraft(key: string, value: string): void {
  /* Unchanged text is a no-op so a minted send key survives the resend;
     edited text mints fresh on the next send. */
  if (value === read(key)?.t) return;
  write(key, { t: value, k: null });
}

export function clearDraft(key: string): void {
  write(key, undefined);
}

/** Drop several drafts at once — session archived, employee removed (AC-6). */
export function dropDrafts(keys: Iterable<string>): void {
  for (const key of keys) clearDraft(key);
}

/** Clear `key`'s stored draft after a send resolves — but only while it
 *  still holds the sent text, so text typed during a slow send survives, and
 *  a switch mid-send clears the *sent* conversation's draft, not whichever
 *  conversation is open at resolve time (AC-5). */
export function clearDraftIfSent(key: string, sent: string): void {
  if (getDraft(key).trim() === sent.trim()) clearDraft(key);
}

/**
 * The [draft, setDraft] pair a host hands to a composer's `draft` /
 * `onDraftChange` props. Reads the stored draft once per key; when `key`
 * changes the new key's draft swaps in during the same render, so the
 * previous conversation's text can't flash in the wrong composer.
 * `undefined` key = nothing to store (typing still works, nothing persists).
 */
export function useDraft(
  key: string | undefined,
): [string, (v: string) => void] {
  const [current, setCurrent] = useState(key);
  const [value, setValue] = useState(() => (key ? getDraft(key) : ""));
  if (current !== key) {
    setCurrent(key);
    setValue(key ? getDraft(key) : "");
  }
  const set = useCallback(
    (v: string) => {
      setValue(v);
      if (key !== undefined) setDraft(key, v);
    },
    [key],
  );
  return [value, set];
}

/**
 * The exactly-once key this draft's send must carry (#552): minted on the
 * first send and stored WITH the draft, so the "Couldn't send" → resend
 * path repeats it across taps — and across reloads, since the draft
 * itself survives — and the relay's `(channelId, dedupeKey)` slot answers
 * a stored-but-unanswered first attempt instead of double-posting. A
 * cleared/edited draft has no key, so the next send mints fresh.
 */
export function draftSendKey(key: string): string {
  const rec = read(key);
  if (rec?.k) return rec.k;
  const k = `u-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  write(key, { t: rec?.t ?? "", k });
  return k;
}
