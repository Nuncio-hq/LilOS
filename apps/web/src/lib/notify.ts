/**
 * Issue #32 — engine events → macOS notifications.
 *
 * Pure seam: `notificationForEvent` classifies a live engine event into a
 * DesktopNotification (or null), and `watchNotifications` wires it to the
 * engine feed with the two AC-1 rules — only done / needs-approval / failed
 * events, and only while that conversation is not in view (a different route,
 * or the app unfocused/hidden). The sink is injected: under Electron it's the
 * `window.lilos.notifications` bridge; tests and plain web supply their own.
 *
 * Events arrive via `engine.onEvent` — live frames only, so `events.since`
 * resync replays can never re-notify old asks.
 */
import type {
  AppChannel,
  Conversation,
  DesktopNotification,
  Employee,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";

export interface NotifyContext {
  conversations: readonly Conversation[];
  channels: readonly AppChannel[];
  employees: readonly Employee[];
}

const conversationOf = (
  sessionId: string,
  ctx: NotifyContext,
): Conversation | undefined =>
  ctx.conversations.find((c) => c.engineRef === sessionId);

const employeeName = (conv: Conversation, ctx: NotifyContext): string => {
  const ch = ctx.channels.find((c) => c.id === conv.channelId);
  const emp = ch && ctx.employees.find((e) => e.id === ch.employeeId);
  return emp?.name ?? "An employee";
};

/** The event → notification classifier. Null = not attention-worthy. */
export function notificationForEvent(
  e: EngineEvent,
  ctx: NotifyContext,
): DesktopNotification | null {
  switch (e.type) {
    case "request.opened": {
      const c = conversationOf(e.sessionId, ctx);
      if (!c) return null;
      const name = employeeName(c, ctx);
      const r = e.payload.request;
      return r.kind === "question"
        ? {
            conversationId: c.id,
            kind: "ask",
            title: `${name} has a question`,
            body: r.question,
          }
        : {
            conversationId: c.id,
            kind: "ask",
            title: `${name} needs your approval`,
            body: r.command,
          };
    }
    case "turn.completed": {
      const { stopReason, error } = e.payload;
      if (stopReason === "cancelled") return null;
      const c = conversationOf(e.sessionId, ctx);
      if (!c) return null;
      const name = employeeName(c, ctx);
      if (error || stopReason === "refusal") {
        return {
          conversationId: c.id,
          kind: "failed",
          title: `${name} hit a problem`,
          body: error ?? `Stopped: ${stopReason}`,
        };
      }
      return {
        conversationId: c.id,
        kind: "done",
        title: `${name} finished`,
        body: c.title || "Turn complete",
      };
    }
    case "session.state": {
      if (e.payload.state !== "error") return null;
      const c = conversationOf(e.sessionId, ctx);
      if (!c) return null;
      const name = employeeName(c, ctx);
      return {
        conversationId: c.id,
        kind: "failed",
        title: `${name} hit a problem`,
        body: e.payload.reason ?? "The session reported an error",
      };
    }
    default:
      return null;
  }
}

/** `/dm/<employee>/<conversation>` params for the conversation a click opens. */
export function routeForConversation(
  conversationId: string,
  ctx: Pick<NotifyContext, "conversations" | "channels">,
): { employeeId: string; conversationId: string } | null {
  const conv = ctx.conversations.find((c) => c.id === conversationId);
  const ch = conv && ctx.channels.find((c) => c.id === conv.channelId);
  return ch ? { employeeId: ch.employeeId, conversationId } : null;
}

/** The conversation currently shown in the thread panel, if any. */
export function openConversationFromPath(pathname: string): string | null {
  const m = /^\/dm\/[^/]+\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface WatchNotificationsOpts {
  /** Live engine frames only (never replayed events). */
  onEvent: (fn: (e: EngineEvent) => void) => () => void;
  context: () => NotifyContext;
  /** Conversation shown in the thread panel right now. */
  openConversationId: () => string | null;
  /** True when the app window is visible and focused. */
  inForeground: () => boolean;
  post: (n: DesktopNotification) => void;
  /**
   * The conversation gets its engineRef via a relay write that can land a
   * hair after a fast engine's first events — re-lookup once after this
   * delay before dropping. Default 500ms.
   */
  retryMs?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Window in which consecutive failures in one conversation post once.
   * Engines emit `turn.completed{error}` and `session.state{error}` as a
   * pair for a single failure; default 1500ms collapses that pair. */
  failureDedupeMs?: number;
}

export function watchNotifications(opts: WatchNotificationsOpts): () => void {
  const now = opts.now ?? (() => Date.now());
  const retryMs = opts.retryMs ?? 500;
  const failureDedupeMs = opts.failureDedupeMs ?? 1500;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastFailedAt = new Map<string, number>();

  const inView = (conversationId: string) =>
    opts.openConversationId() === conversationId && opts.inForeground();

  const dupFailed = (n: DesktopNotification): boolean => {
    if (n.kind !== "failed") return false;
    const t = now();
    const last = lastFailedAt.get(n.conversationId);
    if (last !== undefined && t - last < failureDedupeMs) return true;
    lastFailedAt.set(n.conversationId, t);
    return false;
  };

  const notifyable = (e: EngineEvent): boolean =>
    e.type === "request.opened" ||
    e.type === "turn.completed" ||
    (e.type === "session.state" && e.payload.state === "error");

  const deliver = (e: EngineEvent): void => {
    if (!notifyable(e)) return;
    const n = notificationForEvent(e, opts.context());
    if (!n) {
      // No conversation mapping yet — relay write may land just behind a
      // fast engine's events; retry the lookup once, then drop.
      const key = `${e.sessionId}:${e.seq}`;
      if (!pending.has(key)) {
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            const retry = notificationForEvent(e, opts.context());
            if (retry && !inView(retry.conversationId) && !dupFailed(retry))
              opts.post(retry);
          }, retryMs),
        );
      }
      return;
    }
    if (inView(n.conversationId) || dupFailed(n)) return;
    opts.post(n);
  };

  const unsub = opts.onEvent(deliver);
  return () => {
    unsub();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };
}
