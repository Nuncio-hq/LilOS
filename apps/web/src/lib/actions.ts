import type { AppChannel, Conversation } from "@lilos/contracts/app";
import type { ApprovalOutcome } from "@lilos/contracts/engine";
import { atom } from "nanostores";
import { engine, relay } from "./runtime";

/** The app's only author (single-user build): "user" per the app protocol. */
export const USER_ID = "user";

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
 * (capability `steer`) or queues it as the next prompt.
 */
export async function sendDm(
  employeeId: string,
  text: string,
  conversationId?: string,
): Promise<Conversation> {
  const channel = await openDmChannel(employeeId);
  if (conversationId) {
    await relay.request("messages.post", {
      channelId: channel.id,
      conversationId,
      authorId: USER_ID,
      authorKind: "user",
      text,
    });
    const conv = relay.conversations.get().find((c) => c.id === conversationId);
    return conv as Conversation;
  }
  const res = await relay.request<{
    conversation: Conversation;
    rootMessage: unknown;
  }>("conversations.open", {
    channelId: channel.id,
    authorId: USER_ID,
    text,
  });
  pendingStart.set({ ...pendingStart.get(), [res.conversation.id]: true });
  return res.conversation;
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
