import type {
  Ask,
  Conversation,
  Employee,
  PushKind,
  PushPrefs,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import type { RelayStore } from "./store";

/**
 * Expo push fan-out (#161): turns the two relay-visible transitions —
 * `asks.open` creating an ask, `engine.event` reporting `turn.completed`
 * or `session.state` error — into one Expo push per registered phone.
 *
 * The shape mirrors `apps/web/src/lib/notify.ts` (T3's aggregate-diff
 * model, ported): same classification (approval/plan → needs_approval,
 * question → waiting_for_input, completed/failed terminals, cancelled →
 * silence) and the same failure-collapse window so `turn.completed{error}`
 * + `session.state{error}` for one failure buzzes once.
 *
 * Freshness (AC-2) is the persisted `engine_event_marks` watermark, not a
 * wall clock: a replayed `engine.event` arrives at/under the stored seq so
 * a relay or harness restart can't re-notify — strictly stronger than the
 * 2-minute window the issue describes. Ask pushes ride `createAsk`'s
 * `created` flag, which a replayed `asks.open` already can't re-fire.
 */

export interface ExpoPushMessage {
  /** `ExponentPushToken[...]` of the target phone. */
  to: string;
  /** Employee name (AC-3). */
  title: string;
  /** What it needs / thread title, truncated (AC-3). */
  body: string;
  /** Tap opens the thread — nothing else rides the payload. */
  data: { conversationId: string };
}

export interface ExpoSendResult {
  /** Index into the sent batch. */
  index: number;
  status: "ok" | "error";
  /** Expo `details.error` — "DeviceNotRegistered" drops the token. */
  errorCode?: string;
  message?: string;
}

export type PushSender = (
  messages: ExpoPushMessage[],
) => Promise<ExpoSendResult[]>;

export interface PushFanout {
  /** `asks.open` created a new ask (the transition into needs-you). */
  askOpened(ask: Ask): Promise<void>;
  /** A live `engine.event` the host re-published for a conversation. */
  engineEvent(
    conversation: Conversation,
    sessionId: string,
    event: EngineEvent,
  ): Promise<void>;
  /** The phone reports which thread it has open (null = none/background). */
  setVisibility(deviceId: string, conversationId: string | null): void;
  /** Socket closed or device revoked — forget its visibility report. */
  deviceGone(deviceId: string): void;
}

/** Ask reason as the push body — mirrors `dm-model.ts askReason` (AC-3). */
const askBody = (ask: Ask): string => {
  const request = ask.request;
  switch (request.kind) {
    case "approval":
      return request.description ?? request.command;
    case "plan":
      return "Plan waiting for your review";
    case "question":
      return request.question;
  }
};

const askKind = (ask: Ask): PushKind =>
  ask.request.kind === "question" ? "waiting_for_input" : "needs_approval";

/** Long text is cut at a word boundary so notifications stay one-liners. */
const truncateBody = (text: string, max = 120): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > 0 ? cut.slice(0, boundary) : cut}…`;
};

const prefFor = (prefs: PushPrefs, kind: PushKind): boolean => {
  switch (kind) {
    case "needs_approval":
      return prefs.needsApproval;
    case "waiting_for_input":
      return prefs.waitingForInput;
    case "completed":
      return prefs.completed;
    case "failed":
      return prefs.failed;
  }
};

export function createPushFanout(options: {
  store: RelayStore;
  send: PushSender;
  /** Injectable clock (tests). */
  now?: () => number;
  log?: (message: string) => void;
  /** Min gap between failure pushes for one conversation (default 1500ms —
      the same collapse `apps/web` applies to error+state error pairs). */
  failureCollapseMs?: number;
}): PushFanout {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const collapseMs = options.failureCollapseMs ?? 1500;
  /** Device's latest foreground report — cleared on disconnect/revoke. */
  const visibleThread = new Map<string, string>();
  /** Last failure push per conversation — the collapse window. */
  const failureSentAt = new Map<string, number>();

  const employeeFor = async (
    channelId: string,
  ): Promise<Employee | undefined> => {
    const channel = await store.getChannel(channelId);
    if (!channel) return undefined;
    return (await store.getEmployee(channel.employeeId)) ?? undefined;
  };

  const fan = async (
    kind: PushKind,
    conversation: Conversation,
    body: string,
  ): Promise<void> => {
    if (kind === "failed") {
      const last = failureSentAt.get(conversation.id);
      if (last !== undefined && now() - last < collapseMs) return;
    }
    const targets = (await store.listDevicePush()).filter(
      (target) =>
        prefFor(target.prefs, kind) &&
        visibleThread.get(target.deviceId) !== conversation.id,
    );
    if (targets.length === 0) return;
    const employee = await employeeFor(conversation.channelId);
    const title = employee?.name ?? "LilOS";
    const messages = targets.map((target) => ({
      to: target.token,
      title,
      body: truncateBody(body),
      data: { conversationId: conversation.id },
    }));
    let receipts: ExpoSendResult[];
    try {
      receipts = await options.send(messages);
      /* Mark only a settled send: a throwing send path shouldn't suppress
         the pair leg — zero pushes is worse than a rare double. */
      if (kind === "failed") failureSentAt.set(conversation.id, now());
    } catch (error) {
      /* AC-7: a broken send path (DNS, socket, a misbehaving sender) logs
         and moves on — push must never propagate a failure into the
         relay's request handling. */
      log(`push send failed: ${error}`);
      return;
    }
    for (const receipt of receipts) {
      if (receipt.status === "ok") continue;
      const target = targets[receipt.index];
      const token = target?.token ?? `index ${receipt.index}`;
      log(
        `push send failed (${receipt.errorCode ?? "error"}): ${receipt.message ?? ""} token=${token}`,
      );
      /* AC-7: Expo saying the token is dead is the only error that mutates
         state — the registration is dropped so later transitions skip it. */
      if (receipt.errorCode === "DeviceNotRegistered" && target) {
        await store.dropDevicePush(target.deviceId);
      }
    }
  };

  return {
    async askOpened(ask) {
      const kind = askKind(ask);
      const conversation = await store.getConversation(ask.conversationId);
      if (!conversation) return;
      await fan(kind, conversation, askBody(ask));
    },

    async engineEvent(conversation, sessionId, event) {
      /* Freshness fence first: a replayed publish (seq at/under the stored
         watermark) still re-emits to subscribers — that's #157's job — but
         must never re-notify. */
      const fresh = await store.advanceEngineEventSeq({
        sessionId,
        seq: event.seq,
        at: now(),
      });
      if (!fresh) return;
      let alert: { kind: PushKind; body: string } | undefined;
      if (event.type === "turn.completed") {
        const { stopReason, error } = event.payload;
        if (stopReason === "cancelled") return;
        if (error || stopReason === "refusal") {
          alert = {
            kind: "failed",
            body:
              conversation.title || (error ? `Error: ${error}` : "Turn failed"),
          };
        } else {
          alert = {
            kind: "completed",
            body: conversation.title || "Turn complete",
          };
        }
      } else if (event.type === "session.state") {
        if (event.payload.state !== "error") return;
        alert = {
          kind: "failed",
          body:
            event.payload.reason ?? (conversation.title || "Session failed"),
        };
      }
      if (!alert) return;
      await fan(alert.kind, conversation, alert.body);
    },

    setVisibility(deviceId, conversationId) {
      if (conversationId === null) {
        visibleThread.delete(deviceId);
      } else {
        visibleThread.set(deviceId, conversationId);
      }
    },

    deviceGone(deviceId) {
      visibleThread.delete(deviceId);
    },
  };
}
