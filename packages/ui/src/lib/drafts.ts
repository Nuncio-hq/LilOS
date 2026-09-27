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
};

const storageKey = (key: string) => `${PREFIX}${key}`;

/** Stored draft for `key`, or "" — never throws. */
export function getDraft(key: string): string {
  try {
    return localStorage.getItem(storageKey(key)) ?? "";
  } catch {
    return "";
  }
}

/** Write `value` for `key`; empty text removes the entry (no empty pile-up). */
export function setDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(storageKey(key), value);
    else localStorage.removeItem(storageKey(key));
  } catch {
    // blocked storage → drafts are simply off for this device
  }
}

export function clearDraft(key: string): void {
  setDraft(key, "");
}

/** Drop several drafts at once — session archived, employee removed (AC-6). */
export function dropDrafts(keys: Iterable<string>): void {
  for (const key of keys) clearDraft(key);
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
