import type { ApprovalOutcome } from "@lilos/contracts/engine";
import { draftKey, type V3DataActions } from "@lilos/ui";
import type { HireDraft, SlashItem } from "@lilos/ui/types";
import {
  archiveConversation,
  describeActionError,
  interruptSession,
  refreshModels,
  renameConversation,
  respondToRequest,
  sendDm,
  setModelVisibility,
  toastOnFail,
} from "../lib/actions";
import { HIRE_TEMPLATES, hireEmployee } from "../lib/employees";
import { refreshFolders } from "../lib/folders";
import { flushRewind } from "../lib/rewind";
import { asks, relay } from "../lib/runtime";
import { sendKeyDoneForSend, sendKeyForSend } from "../lib/send-key";
import { sayError } from "../lib/toast";
import { fileSearch } from "../thread/searchers";
import { askForFolder } from "./add-folder";
import { openStatus } from "./banner";
import {
  hireFromProfile,
  listHirableProfiles,
  removeAgent,
  saveAgent,
} from "./employees";
import { pickFromLabel } from "./models";
import { searchMessages } from "./search";
import { v3SettingsActions } from "./settings-actions";
import { employeeOfConversation } from "./threads";

/* What a click in v3 does to the real company. Each action maps to the call
   the pre-v3 screens made (respondToRequest, interruptSession, sendDm, …);
   those already toast their own failures, so the catches here only keep a
   rejection from going unhandled. An action with no backend (rules, plans,
   CEO, connectors, taking a tab over) is simply not in this object, and the
   pages do not draw its control. Comments and hand-off call the ticket
   records (D-#776). */

const conversationOf = (id: string) =>
  relay.conversations.get().find((c) => c.id === id);

/** The employee whose channel holds this conversation. */
function employeeIdOf(conversationId: string): string | undefined {
  const conv = conversationOf(conversationId);
  return conv && employeeOfConversation(conv, relay.channels.get());
}

/** Starter instructions for a hire: the template of the same role if the app
    has one, else one plain line naming the role (the engine's soul text). */
const instructionsFor = (name: string, role: string): string =>
  HIRE_TEMPLATES.find((t) => t.role.toLowerCase() === role.toLowerCase())
    ?.instructions ?? `You are ${name}, the company's ${role.toLowerCase()}.`;

/** `/` in a new chat's box: the engine's commands for this agent and folder. */
function draftCommands(
  scope: { agentId: string; folder?: string },
  query: string,
): Promise<SlashItem[]> {
  const profile = relay.employees
    .get()
    .find((e) => e.id === scope.agentId)?.profile;
  return relay.request<SlashItem[]>("commands.list", {
    agent: profile,
    ...(scope.folder ? { cwd: scope.folder } : {}),
    query,
  });
}

/** What the engine declares that changes which actions exist (D-#19): `agents`
    lets Hire in, `commands` gives a new chat's `/` menu its list. Rebuilt when
    either changes. */
export interface V3Capabilities {
  agents: boolean;
  commands: boolean;
}

export function makeV3Actions(caps: V3Capabilities): V3DataActions {
  const canHire = caps.agents;
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
    comment: (ticketId, text) => {
      void relay
        .request("tickets.comment", { id: ticketId, text })
        .catch((e) =>
          sayError(describeActionError("Couldn't add the update", e)),
        );
    },
    handOff: (ticketId, agentId) => {
      void relay
        .request("tickets.assign", { id: ticketId, ownerId: agentId })
        .catch((e) =>
          sayError(describeActionError("Couldn't hand the ticket on", e)),
        );
    },
    markDone: (ticketId) => {
      void relay
        .request("tickets.update", { id: ticketId, status: "done" })
        .catch((e) =>
          sayError(describeActionError("Couldn't mark the ticket done", e)),
        );
    },
    message: (threadId, text) => {
      const employeeId = employeeIdOf(threadId);
      if (!employeeId) return;
      // A send must see the real post-rewind session, not the visual one.
      void flushRewind(threadId).then(() => sendDm(employeeId, text, threadId));
    },
    startChat: async ({
      agentId,
      folder,
      model,
      pick,
      access,
      text,
      files,
    }) => {
      const conv = await sendDm(
        agentId,
        text,
        undefined,
        // The full picker's choice (model, effort, Fast) when the box has one;
        // else the plain menu's label turned back into a real model.
        pick ?? pickFromLabel(model),
        files,
        /* #552: the send's own key, as the home composer's was — a retry of
           the same message (a failed send keeps the draft and its chips)
           dedupes on the relay instead of opening a second thread. Files
           ride the key, so two file-only sends never collide. */
        sendKeyForSend(`dm:${agentId}`, draftKey.dm(agentId), text, files),
        /* A project's folder is the cwd, and the relay files the thread
           under the project that owns it (D-#771); a plain chat sends none,
           so it only talks. */
        folder,
        access,
      );
      if (conv) sendKeyDoneForSend(`dm:${agentId}`, text, files);
      // A folder a session ran in moves to the top of the recents.
      if (conv) void refreshFolders().catch(() => {});
      return conv?.id;
    },
    searchFiles: (folder, query) => {
      const search = fileSearch(folder);
      return search ? search(query) : Promise.resolve([]);
    },
    /* The engine's own commands, scoped like the old home composer's: the
       agent's profile and the folder the chat will run in (folder-local
       skills ride the cwd). Engines without `commands` get no menu (D-#19). */
    ...(caps.commands ? { searchCommands: draftCommands } : {}),
    /* "New project from a folder…": the app's own folder dialog, then the
       relay makes the folder's project (or answers the one it has). The new
       project is in `relay.projects` by the time `onCreated` runs. */
    newProject: (onCreated) =>
      askForFolder((path) =>
        toastOnFail(
          "Couldn't create the project",
          relay.createProject({ folder: path }).then((p) => onCreated(p.id)),
        ),
      ),
    setModelVisibility: (v) =>
      toastOnFail("Couldn't update the model list", setModelVisibility(v)),
    refreshModels: () =>
      refreshModels().catch((e) => {
        sayError(describeActionError("Couldn't refresh the model list", e));
        throw e;
      }),
    renameThread: (threadId, title) =>
      toastOnFail(
        "Couldn't rename the thread",
        renameConversation(threadId, title),
      ),
    archiveThread: (threadId, archived) =>
      toastOnFail(
        archived
          ? "Couldn't archive the thread"
          : "Couldn't unarchive the thread",
        archiveConversation(threadId, archived),
      ),
    searchMessages,
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
          // Reading the engine's profiles is the `agents` capability's
          // `agents.list`/`agents.describe`: present with `hire`, absent
          // without it. A failed read is an empty list, not a toast: the
          // section it feeds is a second way in, never the only one.
          listProfiles: () => listHirableProfiles().catch(() => []),
          hireProfile: async (p) => {
            try {
              return await hireFromProfile(p);
            } catch (e) {
              sayError(describeActionError("Couldn't hire", e));
              throw e;
            }
          },
        }
      : {}),
    // The company record always saves; the page offers the profile fields
    // the engine accepts (`agentFields`, data.ts).
    updateAgent: async (id, patch) => {
      try {
        return await saveAgent(id, patch);
      } catch (e) {
        sayError(describeActionError("Couldn't save the agent", e));
        throw e;
      }
    },
    removeAgent: async (id) => {
      try {
        await removeAgent(id);
      } catch (e) {
        sayError(describeActionError("Couldn't remove the agent", e));
        throw e;
      }
    },
    showStatus: openStatus,
    ...v3SettingsActions,
  };
}
