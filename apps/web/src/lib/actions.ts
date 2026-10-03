import { RelayError } from "@lilos/client-runtime";
import {
  type AppChannel,
  type Conversation,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type {
  ApprovalOutcome,
  ApprovalPolicy,
  ConversationAccess,
} from "@lilos/contracts/engine";
import type { ModelChoice, ModelVisibility } from "@lilos/ui";
import type { AttachedFile } from "@lilos/ui/types";
import { atom } from "nanostores";
import { defaultAccess, defaultEditor } from "../settings/state";
import { toAttachmentInputs } from "./attachments";
import { USER_ID } from "./me";
import {
  engine,
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  engineProviders,
  modelVisibility,
  relay,
} from "./runtime";
import { say } from "./toast";

export { USER_ID };

/** conversationId -> true while the first engine attach is in flight. */
export const pendingStart = atom<Record<string, boolean>>({});

function dmChannelFor(employeeId: string): AppChannel | undefined {
  return relay.channels
    .get()
    .find((c) => c.kind === "dm" && c.employeeId === employeeId);
}

export async function openDmChannel(employeeId: string): Promise<AppChannel> {
  const existing = dmChannelFor(employeeId);
  if (existing) return existing;
  const res = await relay.request<{ channel: AppChannel }>("channels.openDm", {
    employeeId,
  });
  return res.channel;
}

/**
 * Send a message in the employee's DM. Without a conversation the post opens
 * a fresh one (conversations.open); with one it's a thread reply — and while
 * that conversation's engine turn is running the harness steers it
 * (capability `steer`) or queues it as the next prompt. `files` are the
 * composer's attached images — they ride the same call's `attachments`
 * (base64) so the relay stores them before the turn starts (#112).
 *
 * A failed send surfaces as a plain toast and resolves `undefined` so the
 * caller skips its follow-up navigation (AC-4).
 */
export async function sendDm(
  employeeId: string,
  text: string,
  conversationId?: string,
  pick?: ModelChoice,
  files?: AttachedFile[],
  /** Folder the new session works in (#113); ignored on thread replies. */
  cwd?: string,
  /** #106: the access level the fresh conversation opens on — the
      composer's pill choice; absent → the relay applies Settings'
      defaultAccess. */
  access?: ConversationAccess,
): Promise<Conversation | undefined> {
  try {
    const attachments = toAttachmentInputs(files);
    // A file whose blob → data conversion failed can't cross the wire —
    // refuse the send rather than post the message missing its image.
    if (files?.length && (attachments?.length ?? 0) < files.length) {
      say("An image couldn't be read — nothing was sent. Re-attach it.");
      return undefined;
    }
    const channel = await openDmChannel(employeeId);
    if (conversationId) {
      await relay.request("messages.post", {
        channelId: channel.id,
        conversationId,
        authorId: USER_ID,
        authorKind: "user",
        text,
        ...(attachments ? { attachments } : {}),
      });
      const conv = relay.conversations
        .get()
        .find((c) => c.id === conversationId);
      return conv as Conversation;
    }
    const res = await relay.request<{
      conversation: Conversation;
      rootMessage: unknown;
    }>("conversations.open", {
      channelId: channel.id,
      authorId: USER_ID,
      text,
      ...(attachments ? { attachments } : {}),
      // The pick the composer showed for this fresh session (#92) rides the
      // open call so `session.start` sees it — never a second message.
      ...(pick?.model !== undefined ? { model: pick.model } : {}),
      ...(pick?.provider !== undefined ? { provider: pick.provider } : {}),
      ...(pick?.effort !== undefined ? { effort: pick.effort } : {}),
      ...(pick?.fast !== undefined ? { fast: pick.fast } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(access !== undefined ? { access } : {}),
    });
    pendingStart.set({ ...pendingStart.get(), [res.conversation.id]: true });
    return res.conversation;
  } catch (e) {
    say(describeSendError(e));
    return undefined;
  }
}

/** A failed send in one plain line — the caps the composer enforces, kept
 *  readable when the relay is the one that rejects (AC-4). */
export function describeSendError(e: unknown): string {
  if (e instanceof RelayError) {
    if (e.code === "attachment_too_large")
      return "That image is too large to attach (10 MB max per file).";
    if (e.code === "invalid_params") {
      // Only map attachment validation failures to the images line —
      // unrelated invalid_params errors deserve the generic message.
      const issues = (e.data as { issues?: { path?: unknown[] }[] } | undefined)
        ?.issues;
      if (
        Array.isArray(issues) &&
        issues.some(
          (i) => Array.isArray(i?.path) && i.path.includes("attachments"),
        )
      ) {
        return `Only images, up to ${MAX_ATTACHMENTS_PER_MESSAGE} at once.`;
      }
      return "Couldn't send that. Try again.";
    }
    if (e.code === "not_connected" || e.code === "timeout")
      return "Couldn't reach the relay — try again.";
  }
  return "Couldn't send that. Try again.";
}

/** Optimistic "submitted" marker until the feed sees turn.started. */
export function stillPending(conversationId: string): boolean {
  return pendingStart.get()[conversationId] === true;
}

export function clearPending(conversationId: string): void {
  if (!stillPending(conversationId)) return;
  const next = { ...pendingStart.get() };
  delete next[conversationId];
  pendingStart.set(next);
}

/* ------------------------------ engine ops ------------------------------ */

/** Interrupt the conversation's running turn (relay -> harness -> engine). */
export async function interruptSession(conversationId: string): Promise<void> {
  await relay.request("turns.interrupt", { conversationId });
}

/* Relay failures worth waiting out — the socket is mid-reconnect, so the
   answer is held and re-sent instead of dropped on the floor (#298). */
const TRANSIENT_CODES = new Set([
  "not_connected",
  "socket_closed",
  "timeout",
  "closed",
]);
const ASK_RESPOND_BUDGET_MS = 15_000;

const isTransientRelayError = (e: unknown) =>
  e instanceof RelayError &&
  e.code !== undefined &&
  TRANSIENT_CODES.has(e.code);

/** Resolve once the relay socket reports `ready` again; throw past `deadline`. */
function waitForRelayReady(deadline: number): Promise<void> {
  if (relay.state.get() === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        unsub();
        reject(
          new RelayError("relay did not reconnect in time", "not_connected"),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    const unsub = relay.state.listen((s) => {
      if (s !== "ready") return;
      clearTimeout(timer);
      unsub();
      resolve();
    });
  });
}

/** Answer an engine ask (approval or question) surfaced on the relay. */
export async function respondToRequest(
  askId: string,
  outcome: ApprovalOutcome,
  answer?: string,
): Promise<void> {
  const deadline = Date.now() + ASK_RESPOND_BUDGET_MS;
  for (;;) {
    try {
      return await relay.request("asks.respond", {
        askId,
        outcome,
        ...(answer !== undefined ? { answer } : {}),
      });
    } catch (e) {
      // Already resolved (a retry, or another client answered) or gone —
      // the answer's end state is reached either way.
      if (
        e instanceof RelayError &&
        (e.code === "conflict" || e.code === "not_found")
      )
        return;
      if (!isTransientRelayError(e) || Date.now() >= deadline) {
        say("Couldn't send that answer — try again.");
        throw e;
      }
      await waitForRelayReady(deadline);
    }
  }
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  await relay.request("conversations.update", { conversationId, title });
}

/** #106 AC-1: switch a conversation's access level — applies from the
 *  agent's NEXT action, mid-turn included; rides `conversation.updated`
 *  straight into the session (dedicated method so the pill never falls to
 *  the non-strict update path). */
export async function setConversationAccess(
  conversationId: string,
  access: ConversationAccess,
): Promise<void> {
  await relay.request("conversations.setAccess", { conversationId, access });
}

/** #106 AC-3: Settings' default for new conversations (relay KV). */
export async function setDefaultAccess(
  access: ConversationAccess,
): Promise<void> {
  defaultAccess.set(access);
  await relay.request("settings.set", { key: "defaultAccess", value: access });
}

/** #106: the engine's own approval policy — passthrough `approvals.setPolicy`
 *  (method reachability is the caller's job: only engines declaring
 *  `approval_policy` get the control). */
export async function setApprovalPolicy(policy: ApprovalPolicy): Promise<void> {
  await relay.request("approvals.setPolicy", { policy });
}

/** Pin the pick a conversation's next turn runs on (`conversations.setModel`, #92). */
export async function setConversationModel(
  conversationId: string,
  pick: ModelChoice,
): Promise<void> {
  await relay.request("conversations.setModel", {
    conversationId,
    model: pick.model,
    ...(pick.provider !== undefined ? { provider: pick.provider } : {}),
    ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
    ...(pick.fast !== undefined ? { fast: pick.fast } : {}),
  });
}

/** Re-fetch the engine's model catalog (`models.list {refresh:true}`, #92 AC-6). */
export async function refreshModels(): Promise<void> {
  const r = await relay.listModels({ refresh: true });
  engineModels.set(r.models);
  engineProviders.set(r.providers ?? []);
  engineDefaultModel.set(r.default);
  engineDefaultProvider.set(r.defaultProvider);
}

/** Write the ONE Edit-models hide list (#92 AC-7) — the relay persists and broadcasts it. */
export async function setModelVisibility(v: ModelVisibility): Promise<void> {
  modelVisibility.set(v);
  await relay.request("settings.set", { key: "modelVisibility", value: v });
}

/** Write the Settings default editor (#132) — relay settings KV, same as
 *  modelVisibility; `settings.changed` brings other windows along. */
export async function setDefaultEditor(id: string): Promise<void> {
  defaultEditor.set(id);
  await relay.request("settings.set", { key: "defaultEditor", value: id });
}

/** Shared recent folders (relay-owned, #113). */
export { addFolder, refreshFolders } from "./folders";

export async function archiveConversation(
  conversationId: string,
  archived: boolean,
): Promise<void> {
  await relay.request("conversations.update", { conversationId, archived });
}

/** engine `describe` capability check (e.g. "steer"). */
export function hasCapability(id: string): boolean {
  const caps = engine.description.get()?.capabilities ?? [];
  return caps.some((c) => c.id === id);
}
