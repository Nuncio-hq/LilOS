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
 * Expo push fan-out (D-#161): turns the two relay-visible transitions —
 * `asks.open` creating an ask, `engine.event` reporting `turn.completed`
 * or `session.state` error — into one Expo push per registered phone.
 * The path is this Mac's relay → Expo's push service (`./expo.ts`) → APNs;
 * the phone registers its Expo token + per-kind prefs after pairing, tied
 * to its device id. A sleeping Mac sends nothing (accepted). Not: a LilOS
 * cloud relay, direct APNs with an Apple key on the Mac, or silent /
 * background pre-sync pushes.
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
  /** iOS subtitle — the thread title, truncated (#289). */
  subtitle?: string;
  /** What it needs / the reply excerpt, truncated (AC-3). */
  body: string;
  /** Tap opens the thread; `employeeId` lets a thread gone by tap time
      still name who it was about (#596). */
  data: { conversationId: string; employeeId?: string };
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
  /** The desktop's presence heartbeat (#561): `active` stamps "the human
      is at the Mac" so pushes stay off the phone; `false` (idle/locked)
      clears it early instead of waiting the presence window out. */
  setMacPresence(active: boolean): void;
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

/**
 * The reply as one line of plain text (#289): fenced code blocks dropped
 * outright (never excerpt code), the rest of the markdown flattened —
 * inline code keeps its text, links their label, emphasis its words.
 * Whitespace collapse is `truncateBody`'s job at send time.
 */
const replyExcerpt = (text: string): string =>
  text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\b_([^_]+)_\b/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");

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
  /** How fresh a `presence.report` must be to keep the phone silent
      (#561's N — default 5 min): long enough that a missed heartbeat
      never buzzes the human's pocket mid-flow, short enough that a crashed
      desktop or a walked-away Mac hands notifications back quickly. */
  presenceWindowMs?: number;
}): PushFanout {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const collapseMs = options.failureCollapseMs ?? 1500;
  const presenceWindowMs = options.presenceWindowMs ?? 5 * 60_000;
  /** Latest desktop at-the-Mac report — in-memory like `visibleThread`, never
      persisted (D-#561): a relay restart just falls back to pushing until
      the next heartbeat. */
  let macActiveAt: number | undefined;
  /** Device's latest foreground report — cleared on disconnect/revoke. */
  const visibleThread = new Map<string, string>();
  /** Last failure push per conversation — the collapse window. */
  const failureSentAt = new Map<string, number>();
  /* #289: reply text per in-flight turn — `turn.delta` "text" chunks summed
     like the harness's `textByTurn`, read once on `turn.completed` for the
     excerpt. Cleared with the turn; a relay restart loses it like any live
     stream and the body falls back to the title. */
  const textByTurn = new Map<string, string>();

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
    /* D-#561: notifications route to where the human is. At the Mac (a
       fresh `presence.report`), every kind stays off the phone — finished,
       needs-you and failed alike; the Mac's own banners carry them, reply
       excerpt included. A stale report ages out (idle/quit), an
       `active: false` clears early. Not: the phone deciding routing per
       kind. */
    if (macActiveAt !== undefined && now() - macActiveAt < presenceWindowMs)
      return;
    if (kind === "failed") {
      const last = failureSentAt.get(conversation.id);
      if (last !== undefined && now() - last < collapseMs) return;
    }
    const employee = await employeeFor(conversation.channelId);
    /* D-#561 (AC-3): a muted employee pushes nowhere — `Employee.muted` is
       relay state, and the Mac's banners honour it too. */
    if (employee?.muted) return;
    const targets = (await store.listDevicePush()).filter(
      (target) =>
        prefFor(target.prefs, kind) &&
        visibleThread.get(target.deviceId) !== conversation.id,
    );
    if (targets.length === 0) return;
    const title = employee?.name ?? "LilOS";
    const subtitle = truncateBody(conversation.title);
    const messages = targets.map((target) => ({
      to: target.token,
      title,
      ...(subtitle ? { subtitle } : {}),
      body: truncateBody(body),
      data: {
        conversationId: conversation.id,
        ...(employee ? { employeeId: employee.id } : {}),
      },
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
      if (event.type === "turn.delta") {
        if (event.payload.stream === "text") {
          const key = `${sessionId}:${event.payload.turnId}`;
          textByTurn.set(
            key,
            (textByTurn.get(key) ?? "") + event.payload.delta,
          );
        }
        return;
      }
      if (event.type === "turn.recap") {
        /* #431: a replayed recap stands in for the whole delta run — the
           completion push needs its text for the excerpt. */
        textByTurn.set(
          `${sessionId}:${event.payload.turnId}`,
          event.payload.text,
        );
        return;
      }
      let alert: { kind: PushKind; body: string } | undefined;
      if (event.type === "turn.completed") {
        const { turnId, stopReason, error } = event.payload;
        const reply = textByTurn.get(`${sessionId}:${turnId}`);
        textByTurn.delete(`${sessionId}:${turnId}`);
        if (stopReason === "cancelled") return;
        if (error || stopReason === "refusal") {
          alert = {
            kind: "failed",
            /* The cause over the title — same precedence session.state
               gives `reason`: "what went wrong" reads better in a banner
               than the thread name. */
            body:
              (error ? `Error: ${error}` : undefined) ??
              (conversation.title || "Turn failed"),
          };
        } else {
          /* #289: the banner says what the employee said — the reply
             excerpt, stripped to plain text — and only falls back to the
             thread title when the turn streamed no text at all. */
          const excerpt = reply ? replyExcerpt(reply).trim() : "";
          alert = {
            kind: "completed",
            body: excerpt || conversation.title || "Turn complete",
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

    setMacPresence(active) {
      macActiveAt = active ? now() : undefined;
    },
  };
}
