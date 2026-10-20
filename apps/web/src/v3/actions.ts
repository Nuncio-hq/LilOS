import type { ApprovalOutcome } from "@lilos/contracts/engine";
import type { V3DataActions } from "@lilos/ui";
import type { HireDraft } from "@lilos/ui/types";
import {
  describeActionError,
  interruptSession,
  loadThreadHistory,
  respondToRequest,
  sendDm,
} from "../lib/actions";
import { HIRE_TEMPLATES, hireEmployee } from "../lib/employees";
import { refreshFolders } from "../lib/folders";
import { beginRewind, flushRewind } from "../lib/rewind";
import { asks, relay } from "../lib/runtime";
import { sayError } from "../lib/toast";
import { pickFromLabel } from "./models";
import { v3SettingsActions } from "./settings-actions";
import { employeeOfConversation } from "./threads";

/* What a click in v3 does to the real company. Each action maps to the call
   the pre-v3 screens made (respondToRequest, interruptSession, sendDm, …);
   those already toast their own failures, so the catches here only keep a
   rejection from going unhandled. An action with no backend (hand-off, rules,
   comments, plans, CEO, connectors, taking a tab over) is simply not in this
   object, and the pages do not draw its control. */

const conversationOf = (id: string) =>
  relay.conversations.get().find((c) => c.id === id);

/** The employee whose DM holds this conversation. */
function employeeIdOf(conversationId: string): string | undefined {
  const conv = conversationOf(conversationId);
  return conv && employeeOfConversation(conv, relay.channels.get());
}

/** Rewind to before the message that opened turn `turn` (the nth message you
    sent): hide what follows, open the Undo window, commit when it closes. */
async function rewindTurn(threadId: string, turn: number): Promise<void> {
  const conv = conversationOf(threadId);
  if (!conv) return;
  const { messages } = await loadThreadHistory(
    (method, params) => relay.request(method, params),
    conv.channelId,
    threadId,
  );
  const sent = messages.filter((m) => m.authorKind === "user");
  const target = sent[turn - 1];
  if (!target) return;
  const doomed = messages.filter((m) => m.seq >= target.seq);
  beginRewind(
    { conversationId: threadId, messageId: target.id, draftBefore: "" },
    {
      fromSeq: target.seq,
      ids: doomed.map((m) => m.id),
      texts: doomed
        .filter((m) => m.authorKind === "employee")
        .map((m) => m.text.trim()),
    },
  );
}

/** Starter instructions for a hire: the template of the same role if the app
    has one, else one plain line naming the role (the engine's soul text). */
const instructionsFor = (name: string, role: string): string =>
  HIRE_TEMPLATES.find((t) => t.role.toLowerCase() === role.toLowerCase())
    ?.instructions ?? `You are ${name}, the company's ${role.toLowerCase()}.`;

/** The browser actions the desktop host can run; empty without the bridge. */
function browserActions(): Pick<V3DataActions, "browserOpen" | "browserClose"> {
  const bridge = window.lilos?.browser;
  if (!bridge || bridge.isBrowserWindow) return {};
  return {
    browserOpen: (url, threadId) => {
      const employeeId = employeeIdOf(threadId);
      void bridge.command({
        op: "newTab",
        slotId: `thread:${threadId}`,
        url,
        ...(employeeId ? { group: { threadId, employeeId } } : {}),
      });
    },
    browserClose: (tabId) => void bridge.command({ op: "closeTab", tabId }),
  };
}

/** `canHire`: the engine declares the `agents` capability (D-#19); without
    it Hire is not offered. Rebuilt when that changes. */
export function makeV3Actions(canHire: boolean): V3DataActions {
  const respond = (askId: string, outcome: ApprovalOutcome, answer?: string) =>
    void respondToRequest(askId, outcome, answer).catch(() => {});
  const askOf = (id: string) => asks.get().find((a) => a.id === id);
  return {
    approve: (askId, alwaysAllow) =>
      respond(
        askId,
        askOf(askId)?.request.kind === "plan"
          ? "approve"
          : alwaysAllow
            ? "always"
            : "once",
      ),
    deny: (askId) =>
      respond(askId, askOf(askId)?.request.kind === "plan" ? "reject" : "deny"),
    answer: (askId, option) => {
      const r = askOf(askId)?.request;
      // The card shows labels; the engine wants the option's id.
      const id =
        r?.kind === "question"
          ? r.options?.find((o) => o.label === option)?.id
          : undefined;
      respond(askId, "answer", id ?? option);
    },
    stop: (threadId) =>
      void interruptSession(threadId).catch((e) =>
        sayError(describeActionError("Couldn't stop the turn", e)),
      ),
    message: (threadId, text) => {
      const employeeId = employeeIdOf(threadId);
      if (!employeeId) return;
      // A send must see the real post-rewind session, not the visual one.
      void flushRewind(threadId).then(() => sendDm(employeeId, text, threadId));
    },
    startChat: async ({ agentId, folder, model, text }) => {
      const conv = await sendDm(
        agentId,
        text,
        undefined,
        pickFromLabel(model),
        undefined,
        undefined,
        folder,
      );
      // A folder a session ran in moves to the top of the recents.
      if (conv) void refreshFolders().catch(() => {});
      return conv?.id;
    },
    markSeen: (threadId) =>
      void relay
        .request("conversations.markRead", { conversationId: threadId })
        .catch(() => {}),
    ...(canHire
      ? {
          hire: async ({ name, role, model }) => {
            const pick = pickFromLabel(model);
            const draft: HireDraft = {
              name,
              role,
              model: pick?.model ?? "",
              ...(pick?.provider ? { provider: pick.provider } : {}),
              instructions: instructionsFor(name, role),
            };
            try {
              return (await hireEmployee(draft, null)).id;
            } catch (e) {
              sayError(describeActionError("Couldn't hire", e));
              throw e;
            }
          },
        }
      : {}),
    rewind: (threadId, turn) =>
      void rewindTurn(threadId, turn).catch((e) =>
        sayError(describeActionError("Couldn't rewind the turn", e)),
      ),
    ...browserActions(),
    ...v3SettingsActions,
  };
}
