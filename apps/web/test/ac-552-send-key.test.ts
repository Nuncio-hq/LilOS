// @vitest-environment happy-dom
/* Issue #552 — the send's exactly-once key binds to the CONTENT going
   out: the draft's own persisted key only when the draft itself is sent;
   a session (scope, content) binding for sends that aren't the draft —
   Workbench prompts, file-only sends. A programmatic send must never
   consume or poison the draft's key, or a stored send answers the wrong
   resend and a message is silently swallowed. */
import { draftKey, setDraft } from "@lilos/ui";
import type { AttachedFile } from "@lilos/ui/types";
import { beforeEach, describe, expect, test } from "vitest";
import { sendKeyDoneForSend, sendKeyForSend } from "../src/lib/send-key";

beforeEach(() => localStorage.clear());

const file = (name: string): AttachedFile => ({
  name,
  mediaType: "image/png",
});

describe("send key selection (#552)", () => {
  test("AC-1 a draft send rides the draft's key — stable across resends, surviving a reload", () => {
    const dk = draftKey.thread("conv-1");
    setDraft(dk, "did that land?");
    const k1 = sendKeyForSend("conv:conv-1", dk, "did that land?");
    /* The failed send kept the draft → the resend repeats the same
       persisted key and the relay dedupes the stored first attempt. */
    expect(sendKeyForSend("conv:conv-1", dk, "did that land?")).toBe(k1);
  });

  test("AC-1 a programmatic send can't borrow or poison the draft's key", () => {
    /* Order 1 — draft send first, Workbench send after: the Workbench
       text isn't the draft → session binding, not the draft's key. */
    const dk = draftKey.thread("conv-1");
    setDraft(dk, "fix this");
    const draftKey1 = sendKeyForSend("conv:conv-1", dk, "fix this");
    const wbKey = sendKeyForSend(
      "conv:conv-1",
      dk,
      "Open a PR for this branch",
    );
    expect(wbKey).not.toBe(draftKey1);
    /* Order 2 — Workbench send first: it mustn't write a key into the
       draft record, or the draft's later send repeats it and the stored
       Workbench message swallows the draft. */
    const dk2 = draftKey.thread("conv-2");
    setDraft(dk2, "fix this too");
    const wbKey2 = sendKeyForSend(
      "conv:conv-2",
      dk2,
      "Open a PR for this branch",
    );
    const draftKey2 = sendKeyForSend("conv:conv-2", dk2, "fix this too");
    expect(draftKey2).not.toBe(wbKey2);
    /* Re-clicking the same button resends the SAME content → the session
       binding repeats the key — that's the dedupe working. */
    expect(
      sendKeyForSend("conv:conv-2", dk2, "Open a PR for this branch"),
    ).toBe(wbKey2);
  });

  test("AC-1 a file-only send gets a stable session key, distinct per file set", () => {
    const dk = draftKey.thread("conv-3");
    const k1 = sendKeyForSend("conv:conv-3", dk, "", [file("a.png")]);
    /* Same files re-sent after a failure → same key → dedupe. */
    expect(sendKeyForSend("conv:conv-3", dk, "", [file("a.png")])).toBe(k1);
    /* A different attachment set is a different send → a different key. */
    expect(sendKeyForSend("conv:conv-3", dk, "", [file("b.png")])).not.toBe(k1);
    /* The send resolved → done frees the binding → the next send of the
       same files is deliberate, not a resend. */
    sendKeyDoneForSend("conv:conv-3", "", [file("a.png")]);
    expect(sendKeyForSend("conv:conv-3", dk, "", [file("a.png")])).not.toBe(k1);
  });

  test("AC-1 a draft send with attachments still rides the draft's key", () => {
    const dk = draftKey.thread("conv-4");
    setDraft(dk, "look at this");
    const k1 = sendKeyForSend("conv:conv-4", dk, "look at this", [
      file("a.png"),
    ]);
    expect(sendKeyForSend("conv:conv-4", dk, "look at this", [])).toBe(k1);
  });
});
