import { RelayError } from "@lilos/client-runtime";
import {
  type AppChannel,
  type Conversation,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type { ApprovalOutcome } from "@lilos/contracts/engine";
import type { AttachedFile } from "@lilos/ui/types";
import { atom } from "nanostores";
import { toAttachmentInputs } from "./attachments";
import { USER_ID } from "./me";
import { engine, relay } from "./runtime";
import { say } from "./toast";

export { USER_ID };

/** conversationId -> true while the first engine attach is in flight. */
export const pendingStart = atom<Record<string, boolean>>({});

function dmChannelFor(employeeId: string): AppChannel | undefined {
  return relay.channels
    .get()
    .find((c) => c.kind === "dm" && c.employeeId === employeeId);
}

async function openDmChannel(employeeId: string): Promise<AppChannel> {
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
  files?: AttachedFile[],
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

/** Answer an engine ask (approval or question) surfaced on the relay. */
export async function respondToRequest(
  askId: string,
  outcome: ApprovalOutcome,
  answer?: string,
): Promise<void> {
  await relay.request("asks.respond", {
    askId,
    outcome,
    ...(answer !== undefined ? { answer } : {}),
  });
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  await relay.request("conversations.update", { conversationId, title });
}

/** Pin the model a conversation's next turn runs on (`conversations.setModel`). */
export async function setConversationModel(
  conversationId: string,
  model: string,
): Promise<void> {
  await relay.request("conversations.setModel", { conversationId, model });
}

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
