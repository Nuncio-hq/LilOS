import { sendKeyDone, sendKeyFor } from "@lilos/client-runtime";
import type { AppMessage, Conversation } from "@lilos/contracts/app";
import type { AttachedFile } from "@lilos/ui/types";
import { loadThreadHistory, sendDm, toastOnFail } from "../lib/actions";
import { currentName } from "../lib/me";
import { filesOnlyBanner, flushRewind } from "../lib/rewind";
import { relay } from "../lib/runtime";
import { say } from "../lib/toast";

/* Whole-conversation actions that need no view state — the thread surface
   (panel / session view) and the DM feed rows both call them, so they live
   once here and take what they read as arguments. */

/* #180 AC-4: Change… prefills the composer with this prefix; a send that
   keeps it answers the open plan request instead of posting a message. */
export const PLAN_CHANGE_PREFIX = "Change the plan: ";

/** The engine's `session.compact` (#560 AC-3). The caller gates it on the
    declared `compact` capability (no capability → no button); a refused call
    reads as a plain toast like every other action. */
export function compactConversation(conv: Conversation): void {
  if (!conv.engineRef) return;
  toastOnFail(
    "Couldn't compact the session",
    relay.request("session.compact", { sessionId: conv.engineRef }),
  );
}

/* The last 20 messages as a `> who: text` quote — the recap a fresh session
   carries because the old session's context is all the new one knows. */
function transcriptQuote(msgs: AppMessage[], agentName: string): string {
  return msgs
    .slice(-20)
    .map((m) => {
      const who =
        m.authorKind === "user"
          ? currentName()
          : m.authorKind === "employee"
            ? agentName
            : "note";
      return `> ${who}: ${m.text.replaceAll("\n", "\n> ")}`;
    })
    .join("\n");
}

/* The picker's pick the new session inherits from the old one. */
const pickOf = (conv: Conversation) =>
  conv.model
    ? {
        model: conv.model,
        provider: conv.provider,
        effort: conv.effort,
        fast: conv.fast,
      }
    : undefined;

/** #560 AC-4: fresh session on the same folder, first message carries a
    recap of the thread — the old session's context died full, so the quote
    is all the new one knows. History comes from the relay (a feed row's
    conversation isn't the open thread, so its pool isn't in hand). */
export async function continueInNewSession(
  conv: Conversation,
  employeeId: string,
  agentName: string,
): Promise<void> {
  const { messages: history } = await loadThreadHistory(
    (method, params) => relay.request(method, params),
    conv.channelId,
    conv.id,
  );
  const text =
    "Picking up mid-thread — the previous session's context filled up and was closed. Earlier transcript:\n\n" +
    `${transcriptQuote(history, agentName)}\n\n—`;
  const key = sendKeyFor(`cont:${conv.id}`, text);
  const c = await sendDm(
    employeeId,
    text,
    undefined,
    pickOf(conv),
    undefined,
    key,
    conv.cwd,
  );
  if (c) sendKeyDone(`cont:${conv.id}`, text);
}

/** AC-3 follow-up: a fresh session on the same folder, seeded with the
    surviving transcript as quoted context + the rewound message's text (the
    composer's current draft — the user may have edited it). Resolves to the
    new conversation so the caller can open it (#577: where a new send
    lands — beside the list, not a jump into the session view). */
export async function startFreshFrom(
  conv: Conversation,
  target: AppMessage,
  a: {
    pool: AppMessage[];
    employeeId: string;
    agentName: string;
    draft: string;
    seedFiles?: AttachedFile[];
  },
): Promise<Conversation | undefined> {
  const kept = a.pool.filter((m) => m.seq < target.seq);
  const text =
    "Picking up mid-thread after a rewind — earlier transcript:\n\n" +
    `${transcriptQuote(kept, a.agentName)}\n\n—\n\n` +
    (a.draft.trim() || target.text);
  const key = sendKeyFor(`sfresh:${conv.id}`, text);
  const c = await sendDm(
    a.employeeId,
    text,
    undefined,
    pickOf(conv),
    a.seedFiles,
    key,
    conv.cwd,
  );
  if (c) {
    sendKeyDone(`sfresh:${conv.id}`, text);
    filesOnlyBanner.set(null);
  }
  return c;
}

/** #419 AC-2: Retry re-sends the user's last delivered message into the
    same session — a new user row the harness prompts as a fresh turn under
    the failed one (not a ghost re-prompt). Messages the engine never took
    (dropped/removed/rewound) can't be the retry text; the summary's root
    covers a conv whose replies fell out of the window. */
export function retryConversation(
  conv: Conversation,
  employeeId: string,
  candidates: AppMessage[],
  summaryRootText: string | undefined,
): void {
  const last = candidates
    .filter(
      (m) =>
        m.conversationId === conv.id &&
        m.authorKind === "user" &&
        !m.dropped &&
        !m.removed &&
        !m.rewound,
    )
    .reduce<AppMessage | undefined>(
      (a, m) => (!a || m.seq > a.seq ? m : a),
      undefined,
    );
  const text = last?.text ?? summaryRootText;
  if (!text) {
    say("Nothing to retry — the thread has no sent message.");
    return;
  }
  /* #552: one key per (conv, retried text) — a second click after the
     first attempt's answer died with the socket repeats it, so the stored
     retry dedupes instead of posting again. The binding frees on resolve,
     so retrying a landed turn is still a real retry. */
  const key = sendKeyFor(`retry:${conv.id}`, text);
  /* #578: Retry sends into the real post-rewind session — a pending rewind
     in this conversation commits first. */
  void flushRewind(conv.id)
    .then(() => sendDm(employeeId, text, conv.id, undefined, undefined, key))
    .then((c) => {
      if (c) sendKeyDone(`retry:${conv.id}`, text);
    });
}
