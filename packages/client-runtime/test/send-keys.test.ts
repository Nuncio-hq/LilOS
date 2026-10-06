/* Issue #552 AC-1 — the send's dedupe key belongs to the draft, not the
   tap: a resend of an unchanged draft repeats the first attempt's key (a
   stored-but-unanswered request dedupes on the relay instead of posting
   twice), edited text mints fresh, and a resolved send frees the slot so
   a deliberate re-post is a new send. */
import { describe, expect, it } from "vitest";
import { sendKeyDone, sendKeyFor } from "../src/send-keys";

describe("send keys (#552)", () => {
  it("AC-1 a resend of the same draft repeats the key; edits mint fresh", () => {
    const scope = `conv:${crypto.randomUUID()}`;
    const first = sendKeyFor(scope, "did that land?");
    /* The failed send restores the same text — the retry must carry the
       original key or the relay can't dedupe the stored write. */
    expect(sendKeyFor(scope, "did that land?")).toBe(first);
    /* Editing the draft is a new send — a different key. */
    expect(sendKeyFor(scope, "did that land? edited")).not.toBe(first);
  });

  it("AC-1 scopes are independent; a resolved send frees its slot", () => {
    const a = `conv:${crypto.randomUUID()}`;
    const b = `dm:${crypto.randomUUID()}`;
    const ka = sendKeyFor(a, "same text");
    const kb = sendKeyFor(b, "same text");
    expect(ka).not.toBe(kb);

    sendKeyDone(a, "same text");
    /* After the first send resolved, typing the same text again is a
       deliberate re-post — a new key, never a dedupe hit. */
    expect(sendKeyFor(a, "same text")).not.toBe(ka);
    /* B's pending send is untouched. */
    expect(sendKeyFor(b, "same text")).toBe(kb);
    sendKeyDone(b, "same text");
  });
});
