import { sendKeyDone, sendKeyFor } from "@lilos/client-runtime";
import { draftSendKey, getDraft } from "@lilos/ui";
import type { AttachedFile } from "@lilos/ui/types";

/* #552: the send's exactly-once key binds to the CONTENT going out, not
   the draft record — the draft's own persisted key is right only when the
   draft itself is the send (it survives a reload, so a stored-but-
   unanswered resend repeats it). Sends that aren't the draft — Workbench
   prompts, file-only sends — mustn't borrow the draft's key: the stored
   send would then answer the next draft send's resend and swallow it.
   Those get a session-scoped (scope, content) binding instead; files ride
   the tag so two file-only sends never collide. */
const contentTag = (text: string, files?: AttachedFile[]): string =>
  files?.length ? `${text}files:${files.map((f) => f.name).join("")}` : text;

/** The key for a send of `text` (+files) on `scope`; `draftStorageKey` is
    the draft the send may have come from — used only when its stored text
    IS what's being sent. */
export function sendKeyForSend(
  scope: string,
  draftStorageKey: string,
  text: string,
  files?: AttachedFile[],
): string {
  if (text !== "" && getDraft(draftStorageKey) === text)
    return draftSendKey(draftStorageKey);
  return sendKeyFor(scope, contentTag(text, files));
}

/** Free the session binding once the send resolved — a no-op when the
    send rode the draft's key (the draft clear owns that lifecycle). */
export function sendKeyDoneForSend(
  scope: string,
  text: string,
  files?: AttachedFile[],
): void {
  sendKeyDone(scope, contentTag(text, files));
}
