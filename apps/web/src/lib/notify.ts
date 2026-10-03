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
import type { EngineEvent, EngineRequest } from "@lilos/contracts/engine";

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

const askNotification = (
  sessionId: string,
  request: EngineRequest,
  ctx: NotifyContext,
): DesktopNotification | null => {
  const c = conversationOf(sessionId, ctx);
  if (!c) return null;
  const name = employeeName(c, ctx);
  switch (request.kind) {
    case "question":
      return {
        conversationId: c.id,
        kind: "ask",
        title: `${name} has a question`,
        body: request.question,
      };
    /* #180: an engine proposing a plan needs the human the same way an
       approval does; the card itself lands with the app half of the issue. */
    case "plan":
      return {
        conversationId: c.id,
        kind: "ask",
        title: `${name} proposed a plan`,
        body: "Approve, ask for a change, or reject it.",
      };
    default:
      return {
        conversationId: c.id,
        kind: "ask",
        title: `${name} needs your approval`,
        body: request.command,
      };
  }
};

/** The event → notification classifier. Null = not attention-worthy. */
export function notificationForEvent(
  e: EngineEvent,
  ctx: NotifyContext,
): DesktopNotification | null {
  switch (e.type) {
    case "request.opened":
      return askNotification(e.sessionId, e.payload.request, ctx);
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

/** Per-session seq record for the state-driven completion check. */
interface CompletionSeqStore {
  /** Accounted seqs; `undefined` means the watcher has never seen the session. */
  read(sessionId: string): readonly number[] | undefined;
  write(sessionId: string, seqs: readonly number[]): void;
}

const COMPLETION_SEQS_KEY = "lilos:notifiedCompletions";

/** sessionStorage-backed `completionSeqs` — survives a same-tab reload. */
const defaultCompletionSeqs = (): CompletionSeqStore | undefined => {
  if (typeof sessionStorage === "undefined") return undefined;
  const readAll = (): Record<string, number[]> => {
    try {
      const raw = sessionStorage.getItem(COMPLETION_SEQS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, number[]>) : {};
    } catch {
      return {};
    }
  };
  return {
    read: (sessionId) => readAll()[sessionId],
    write: (sessionId, seqs) => {
      const all = readAll();
      all[sessionId] = [...seqs];
      try {
        sessionStorage.setItem(COMPLETION_SEQS_KEY, JSON.stringify(all));
      } catch {
        /* quota or private mode — the in-page set still dedupes this mount. */
      }
    },
  };
};

export interface WatchNotificationsOpts {
  /** Live engine frames only (never replayed events). */
  onEvent: (fn: (e: EngineEvent) => void) => () => void;
  context: () => NotifyContext;
  /** Conversation shown in the thread panel right now. */
  openConversationId: () => string | null;
  /** True when the app window is visible and focused. */
  inForeground: () => boolean;
  /**
   * Whether a request is still open — consulted on the retry path, so an ask
   * resolved in the retry window doesn't post stale.
   */
  isRequestOpen?: (requestId: string) => boolean;
  /**
   * The currently-open asks across sessions — replayed engine state, not
   * live events. When provided, asks post from this set on every state or
   * view change instead of only on the live `request.opened` frame, so an
   * ask survives page reloads and in-view suppression (#84: engine-fake's
   * request.opened beating the navigate-away left `postKeys` empty on CI).
   */
  openAsks?: () => ReadonlyArray<{
    sessionId: string;
    requestId: string;
    request: EngineRequest;
  }>;
  /** Fires when the openAsks set may have changed (feed/session updates). */
  onOpenAsksChange?: (fn: () => void) => () => void;
  /**
   * Fires when which conversation is in view may have changed (route change,
   * focus, visibility). Re-checks open asks against the new view.
   */
  onViewChange?: (fn: () => void) => () => void;
  /**
   * `turn.completed` + `session.state{error}` events per watched session —
   * replayed feed state, not live frames. When provided (with
   * `completionSeqs`), done/failed post from this set on every state or view
   * change, so a completion that lost its live frame — a reload gap with
   * zero feed peers, an in-view suppression, a late engineRef mapping past
   * the retry — still surfaces once (#400: same recovery the #84 asks got).
   * Sessions report with an empty list too — seeing a session before its
   * first completion is what lets the seed tell history from missed-live.
   */
  completionEvents?: () => ReadonlyArray<{
    sessionId: string;
    events: readonly EngineEvent[];
  }>;
  /**
   * Per-session record of completion seqs already accounted (posted or
   * classified terminal like a cancelled turn). Persisted across a reload
   * so a completion that missed its live frame is still "new" to the fresh
   * page while replayed history stays silent. Defaults to sessionStorage
   * when present; tests inject a plain store.
   */
  completionSeqs?: CompletionSeqStore;
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
  // Asks already posted, keyed by requestId — dedupes the live fast-path
  // against the state-driven check below.
  const postedAsks = new Set<string>();
  /* Completion seqs already accounted this mount; the optional store
     carries the same record across a reload. */
  const handledSeqs = new Set<string>();
  const seededSessions = new Set<string>();
  const seqStore = opts.completionSeqs ?? defaultCompletionSeqs();

  const seqSeen = (sessionId: string, seq: number): boolean =>
    handledSeqs.has(`${sessionId}:${seq}`) ||
    (seqStore?.read(sessionId)?.includes(seq) ?? false);

  const recordSeq = (sessionId: string, seq: number): void => {
    handledSeqs.add(`${sessionId}:${seq}`);
    const cur = seqStore?.read(sessionId);
    if (cur && !cur.includes(seq)) seqStore?.write(sessionId, [...cur, seq]);
  };

  const seeded = (sessionId: string): boolean =>
    seededSessions.has(sessionId) || seqStore?.read(sessionId) !== undefined;

  const seed = (sessionId: string, seqs: readonly number[]): void => {
    seededSessions.add(sessionId);
    for (const seq of seqs) handledSeqs.add(`${sessionId}:${seq}`);
    if (seqStore && seqStore.read(sessionId) === undefined)
      seqStore.write(sessionId, seqs);
  };

  const inView = (conversationId: string) =>
    opts.openConversationId() === conversationId && opts.inForeground();

  /**
   * Post every ask that is still open and not in view. Driven by state (not
   * the event stream) so it re-evaluates after reloads, late conversation
   * mappings, and every view change — an ask answered while in view simply
   * stops appearing in openAsks and is never posted.
   */
  const checkAsks = (): void => {
    if (!opts.openAsks) return;
    const ctx = opts.context();
    for (const a of opts.openAsks()) {
      if (postedAsks.has(a.requestId)) continue;
      const n = askNotification(a.sessionId, a.request, ctx);
      if (!n || inView(n.conversationId)) continue;
      postedAsks.add(a.requestId);
      opts.post(n);
    }
  };

  /**
   * Post every completion that is new and not in view. Driven by feed
   * state (not the live stream) so a done/failed that missed its frame —
   * emitted while the page had no feed peer, suppressed because its
   * conversation was in view, or unmapped at the retry — re-evaluates on
   * the next check instead of vanishing (#400). Seeding marks everything
   * present at first sight of a session as history: only seqs no earlier
   * mount accounted for ever post.
   */
  const checkCompletions = (): void => {
    if (!opts.completionEvents) return;
    const ctx = opts.context();
    for (const { sessionId, events } of opts.completionEvents()) {
      if (!seeded(sessionId)) {
        seed(
          sessionId,
          events.map((e) => e.seq),
        );
        continue;
      }
      for (const e of events) {
        if (seqSeen(sessionId, e.seq)) continue;
        const n = notificationForEvent(e, ctx);
        if (!n) {
          /* Cancelled turns are terminal-quiet — account them so they never
             re-evaluate. Any other null is an unmapped conversation: the
             engineRef write can still land, so leave it for the next check. */
          if (
            e.type === "turn.completed" &&
            e.payload.stopReason === "cancelled"
          )
            recordSeq(sessionId, e.seq);
          continue;
        }
        /* In view right now: the thread renders the finished turn, so the
           user is looking at the outcome — account it, don't post. (Asks
           differ: still open, still owed — checkAsks leaves them pending.) */
        if (inView(n.conversationId)) {
          recordSeq(sessionId, e.seq);
          continue;
        }
        if (dupFailed(n)) {
          recordSeq(sessionId, e.seq);
          continue;
        }
        recordSeq(sessionId, e.seq);
        opts.post(n);
      }
    }
  };

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
    const ctx = opts.context();
    const n = notificationForEvent(e, ctx);
    if (!n) {
      // A mapped conversation means the event classified as uninteresting
      // (e.g. cancelled turn) — only an unmapped one is worth retrying, since
      // the relay write may land just behind a fast engine's events.
      if (conversationOf(e.sessionId, ctx)) return;
      const key = `${e.sessionId}:${e.seq}`;
      if (!pending.has(key)) {
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            // A request resolved in the retry window would post stale.
            if (
              e.type === "request.opened" &&
              opts.isRequestOpen &&
              !opts.isRequestOpen(e.payload.requestId)
            )
              return;
            const retry = notificationForEvent(e, opts.context());
            if (!retry) return;
            if (inView(retry.conversationId)) return; // checkAsks owns asks
            if (
              e.type === "request.opened" &&
              postedAsks.has(e.payload.requestId)
            )
              return;
            if (e.type === "request.opened")
              postedAsks.add(e.payload.requestId);
            else recordSeq(e.sessionId, e.seq);
            if (!dupFailed(retry)) opts.post(retry);
          }, retryMs),
        );
      }
      return;
    }
    if (inView(n.conversationId)) {
      /* Watched it happen — a completion is accounted (the check never
         reposts it on a later view change); an ask stays pending for
         checkAsks since it is still open and still owed. */
      if (e.type !== "request.opened") recordSeq(e.sessionId, e.seq);
      return;
    }
    if (e.type === "request.opened") {
      if (postedAsks.has(e.payload.requestId)) return;
      postedAsks.add(e.payload.requestId);
    } else recordSeq(e.sessionId, e.seq); // delivered — the check never reposts
    if (dupFailed(n)) return;
    opts.post(n);
  };

  /* One state-driven pass over asks + completions — both recover what the
     live stream dropped; asks need an open ask, completions an unaccounted
     seq. */
  const checkState = (): void => {
    checkAsks();
    checkCompletions();
  };

  const unsub = opts.onEvent(deliver);
  const unsubAsks = opts.onOpenAsksChange?.(checkState);
  const unsubView = opts.onViewChange?.(checkState);
  checkState();
  return () => {
    unsub();
    unsubAsks?.();
    unsubView?.();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    postedAsks.clear();
  };
}
