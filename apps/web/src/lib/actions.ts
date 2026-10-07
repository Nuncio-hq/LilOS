import { RelayError } from "@lilos/client-runtime";
import {
  type AppChannel,
  type AppMessage,
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
import { applyModelCatalog, engine, modelVisibility, relay } from "./runtime";
import { sayError } from "./toast";

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
 * A send made while the socket is down (the "Reconnecting…" line is up)
 * isn't a failure: the wire calls retry on transient errors within
 * `SEND_BUDGET_MS`, repeating the same `dedupeKey` so an attempt that
 * stored the write before its answer died dedupes relay-side instead of
 * double-posting — the send lands exactly once (#557 AC-2, on #552's key).
 * A send that still can't land surfaces as a plain toast and resolves
 * `undefined` so the caller skips its follow-up navigation (AC-4).
 */
export async function sendDm(
  employeeId: string,
  text: string,
  conversationId?: string,
  pick?: ModelChoice,
  files?: AttachedFile[],
  /** #552: the send's exactly-once key — the draft's own, repeated on a
      resend so a stored-but-unanswered first attempt dedupes on the
      relay instead of double-posting. */
  dedupeKey?: string,
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
      sayError("An image couldn't be read — nothing was sent. Re-attach it.");
      return undefined;
    }
    const deadline = Date.now() + SEND_BUDGET_MS;
    for (;;) {
      try {
        const channel = await openDmChannel(employeeId);
        if (conversationId) {
          await relay.request("messages.post", {
            channelId: channel.id,
            conversationId,
            authorId: USER_ID,
            authorKind: "user",
            text,
            ...(attachments ? { attachments } : {}),
            ...(dedupeKey ? { dedupeKey } : {}),
          });
          const conv = relay.conversations
            .get()
            .find((c) => c.id === conversationId);
          return conv;
        }
        const res = await relay.request<{
          conversation: Conversation;
          rootMessage: unknown;
        }>("conversations.open", {
          channelId: channel.id,
          authorId: USER_ID,
          text,
          ...(attachments ? { attachments } : {}),
          ...(dedupeKey ? { dedupeKey } : {}),
          // The pick the composer showed for this fresh session (#92) rides
          // the open call so `session.start` sees it — never a second
          // message.
          ...(pick?.model !== undefined ? { model: pick.model } : {}),
          ...(pick?.provider !== undefined ? { provider: pick.provider } : {}),
          ...(pick?.effort !== undefined ? { effort: pick.effort } : {}),
          ...(pick?.fast !== undefined ? { fast: pick.fast } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(access !== undefined ? { access } : {}),
        });
        pendingStart.set({
          ...pendingStart.get(),
          [res.conversation.id]: true,
        });
        return res.conversation;
      } catch (e) {
        /* #557: a transient drop mid-send (or a send typed while the
           Reconnecting line is already up) waits out the reconnect, then
           repeats with the same dedupeKey — exactly once on the relay. A
           send that's still failing at the deadline falls through to the
           toast the catch above always rendered. */
        if (!isTransientRelayError(e) || Date.now() >= deadline) throw e;
        await waitForRelayReady(deadline);
      }
    }
  } catch (e) {
    sayError(describeSendError(e));
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

/* The one plain reading of "the agent can't be reached" — the wire's
   "engine host" phrasing, raw codes and stack text never reach a toast
   (#423 review). */
const CONNECTION_LOST =
  "LilOS lost its connection to the agent. Try again in a moment.";

/**
 * One plain line for a failed DM action (#423 AC-1): transport trouble
 * reads as reconnecting / no answer, the engine host being gone reads as
 * a lost connection, and a relay-side reason rides through as-is — the
 * toast always says why in words a user can act on. `action` is the
 * leading "Couldn't …" fragment.
 */
export function describeActionError(action: string, e: unknown): string {
  if (e instanceof RelayError) {
    if (
      e.code === "not_connected" ||
      e.code === "socket_closed" ||
      e.code === "closed" ||
      e.code === "connect_failed" ||
      e.code === "connect_timeout"
    ) {
      return `${action} — LilOS is reconnecting; try again in a moment.`;
    }
    if (e.code === "timeout")
      return `${action} — the relay didn't answer; try again.`;
    if (e.code === "engine_unavailable")
      return `${action} — ${CONNECTION_LOST}`;
    /* "invalid params" is a refused request, not user copy. */
    if (e.code === "invalid_params") return `${action} — try again.`;
  }
  const raw = e instanceof Error ? e.message : e == null ? "" : String(e);
  if (e == null) return action;
  /* First line only — a stack tail is never toast copy. A reason that is
     itself jargon ("engine host …"), a bare snake_case code, an errno
     (ENOENT…) or a stringified object collapses to the plain line /
     a bare "try again". */
  const reason = raw.split("\n", 1)[0].trim();
  if (/engine host/i.test(reason)) return `${action} — ${CONNECTION_LOST}`;
  if (
    !reason ||
    /^\[object /.test(reason) ||
    (/^[a-z][a-z0-9_]*$/.test(reason) && reason.includes("_")) ||
    /\bE[A-Z][A-Z0-9]{2,}\b/.test(reason)
  )
    return `${action} — try again.`;
  return `${action} — ${reason}`;
}

/**
 * Fire-and-forget a DM action that can reject: the rejection becomes a
 * toast instead of landing nowhere (#423 AC-1). Actions that answer with
 * their own error UI (asks.respond's line, a failed send's draft) keep
 * their own wording — this is for calls that had NO visible outcome.
 */
export function toastOnFail(action: string, p: Promise<unknown>): void {
  void p.catch((e) => sayError(describeActionError(action, e)));
}

/**
 * The open thread's whole visible history (#28 AC-2): paged `messages.list`
 * scoped to the conversation. Rejects so the caller can show the retryable
 * notice — the fetch is never swallowed (#423 AC-2). `request` is injected
 * so tests can force the rejection.
 */
export async function loadThreadHistory(
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>,
  channelId: string,
  conversationId: string,
): Promise<{
  messages: AppMessage[];
  rewoundIds: ReadonlySet<string>;
  rewoundTexts: ReadonlySet<string>;
}> {
  const all: AppMessage[] = [];
  for (;;) {
    const page = (await request("messages.list", {
      channelId,
      conversationId,
      afterSeq: all.at(-1)?.seq ?? 0,
      limit: 200,
      includeRewound: true,
      /* #315: parked not-sent rows ride the fetch so the tray survives a
         reload (relay truth, not component state). */
      includeDropped: true,
    })) as { messages: AppMessage[] };
    all.push(...page.messages);
    if (page.messages.length < 200) break;
  }
  const rewound = all.filter((m) => m.rewound);
  return {
    messages: all.filter((m) => !m.rewound),
    rewoundIds: new Set(rewound.map((m) => m.id)),
    rewoundTexts: new Set(
      rewound
        .filter((m) => m.authorKind === "employee")
        .map((m) => m.text.trim()),
    ),
  };
}

/** Optimistic "submitted" marker until the feed sees turn.started. */
function stillPending(conversationId: string): boolean {
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
/* #557: same budget for a user send caught in an outage — long enough to
   ride out one reconnect cycle (backoff tops out at 4 s), short enough
   that a send that still can't land ends in the usual toast. */
const SEND_BUDGET_MS = 15_000;

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
        sayError("Couldn't send that answer — try again.");
        throw e;
      }
      /* The budget running out inside the wait throws past the catch —
         the callers swallow it, so the toast has to land here (#423). */
      try {
        await waitForRelayReady(deadline);
      } catch (wait) {
        sayError(describeActionError("Couldn't send that answer", wait));
        throw wait;
      }
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

/** Re-fetch the engine's model catalog (`models.list {refresh:true}`, #92
 *  AC-6). Still a thrower — the caller toasts a failure (#423 AC-1); an
 *  answered-empty keeps the known rows instead of blanking the picker. */
export async function refreshModels(): Promise<void> {
  applyModelCatalog(await relay.listModels({ refresh: true }));
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

export async function archiveConversation(
  conversationId: string,
  archived: boolean,
): Promise<void> {
  await relay.request("conversations.update", { conversationId, archived });
}

/** #581 AC-2: move a thread's working folder — the engine re-homes the
 *  session (same thread, same memory) when it declares `workspace_move`;
 *  the relay writes a system note saying exactly what happened. */
export async function moveConversationFolder(
  conversationId: string,
  path: string,
): Promise<void> {
  await relay.request("conversations.moveFolder", { conversationId, path });
}

/** engine `describe` capability check (e.g. "steer"). */
export function hasCapability(id: string): boolean {
  const caps = engine.description.get()?.capabilities ?? [];
  return caps.some((c) => c.id === id);
}
