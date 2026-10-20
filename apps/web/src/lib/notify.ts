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
  /**
   * The text a turn streamed, looked up from the session's event feed
   * (`turn.delta` text + `turn.recap`) — gives the done banner the reply
   * excerpt (#561 AC-2). Absent → done banners fall back to the thread
   * title as before.
   */
  turnText?: (sessionId: string, turnId: string) => string | undefined;
}

const conversationOf = (
  sessionId: string,
  ctx: NotifyContext,
): Conversation | undefined =>
  ctx.conversations.find((c) => c.engineRef === sessionId);

const employeeOf = (
  conv: Conversation,
  ctx: NotifyContext,
): Employee | undefined => {
  const ch = ctx.channels.find((c) => c.id === conv.channelId);
  return ch ? ctx.employees.find((e) => e.id === ch.employeeId) : undefined;
};

const employeeName = (conv: Conversation, ctx: NotifyContext): string =>
  employeeOf(conv, ctx)?.name ?? "An employee";

/** Long text is cut at a word boundary so the banner stays a one-liner —
    mirrors `apps/relay/src/push.ts truncateBody` (#561). */
const truncateBody = (text: string, max = 120): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > 0 ? cut.slice(0, boundary) : cut}…`;
};

/** The reply as one line of plain text — markdown flattened, code fences
    dropped. Mirrors `apps/relay/src/push.ts replyExcerpt` (#561). */
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

const askNotification = (
  sessionId: string,
  request: EngineRequest,
  ctx: NotifyContext,
): DesktopNotification | null => {
  const c = conversationOf(sessionId, ctx);
  if (!c) return null;
  /* #561 AC-3: a muted employee notifies nowhere — banner or push. */
  if (employeeOf(c, ctx)?.muted) return null;
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
        /* What's needed (#561 AC-2) — the description when the engine
           gave one, else the raw command (the relay's askBody agrees). */
        body: request.description ?? request.command,
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
      /* #561 AC-3: a muted employee notifies nowhere. */
      if (employeeOf(c, ctx)?.muted) return null;
      const name = employeeName(c, ctx);
      if (error || stopReason === "refusal") {
        return {
          conversationId: c.id,
          kind: "failed",
          title: `${name} hit a problem`,
          body: error ?? `Stopped: ${stopReason}`,
        };
      }
      /* #561 AC-2: the banner says what the employee said — the reply
         excerpt from the feed's turn text — with the thread title as the
         fallback when the turn streamed nothing (the relay's push body
         does the same). */
      const excerpt = replyExcerpt(
        ctx.turnText?.(e.sessionId, e.payload.turnId) ?? "",
      ).trim();
      return {
        conversationId: c.id,
        kind: "done",
        title: `${name} finished`,
        body: truncateBody(excerpt || c.title || "Turn complete"),
      };
    }
    case "session.state": {
      if (e.payload.state !== "error") return null;
      const c = conversationOf(e.sessionId, ctx);
      if (!c) return null;
      if (employeeOf(c, ctx)?.muted) return null;
      const name = employeeName(c, ctx);
      return {
        conversationId: c.id,
        kind: "failed",
        title: `${name} hit a problem`,
        body: e.payload.reason ?? "The thread reported an error",
      };
    }
    default:
      return null;
  }
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
  /* #561 AC-2: the done banner's reply excerpt — turn text folded from
     the same frames the classifier sees (live deltas and replayed
     recaps alike), the relay's push excerpt fold mirrored. Feeds only
     exist for watched sessions, so the off-view conversations that
     actually notify can't be read back — accumulate instead. */
  const turnTexts = new Map<string, string>();
  /* Replays re-emit the same seqs every check — fold each frame once or
     an appended delta would double its text. */
  const foldedSeqs = new Set<string>();
  const foldTurnText = (e: EngineEvent): void => {
    /* A recap re-stamps the whole stream at the delta run's anchor seq —
       the feed merge lets it replace a held delta at that seq, so it folds
       unconditionally (re-applying is a no-op); only deltas dedup by seq. */
    if (e.type === "turn.recap") {
      turnTexts.set(`${e.sessionId}:${e.payload.turnId}`, e.payload.text);
    } else if (e.type === "turn.delta") {
      const seqKey = `${e.sessionId}:${e.seq}`;
      if (foldedSeqs.has(seqKey)) return;
      foldedSeqs.add(seqKey);
      if (e.payload.stream !== "text") return;
      const key = `${e.sessionId}:${e.payload.turnId}`;
      turnTexts.set(key, (turnTexts.get(key) ?? "") + e.payload.delta);
    } else return;
    /* Bounded: a watched session streams thousands of turns over a long
       uptime — keep the newest half once past a generous cap. */
    if (turnTexts.size > 4096) {
      const drop = [...turnTexts.keys()].slice(0, 2048);
      for (const k of drop) turnTexts.delete(k);
    }
  };
  /* The context plus the fold — a supplied `turnText` (tests, a caller
     with its own source) stands when the fold never saw the turn. */
  const ctxFor = (): NotifyContext => ({
    ...opts.context(),
    turnText: (sessionId, turnId) =>
      turnTexts.get(`${sessionId}:${turnId}`) ??
      opts.context().turnText?.(sessionId, turnId),
  });
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
    for (const a of opts.openAsks()) {
      if (postedAsks.has(a.requestId)) continue;
      const n = askNotification(a.sessionId, a.request, ctxFor());
      if (!n || inView(n.conversationId)) continue;
      postedAsks.add(a.requestId);
      opts.post(n);
    }
  };

  /* Seq high-water per session: a check scans every feed event, and delta
     frames now ride the same list — rescanning a streamed turn on every
     model update grows quadratically. Frames at or under the mark folded
     already, so only a recap re-stamping inside the range or a still-
     unaccounted notifyable (unmapped conversation, retried below) is
     worth a revisit. */
  const scannedSeqs = new Map<string, number>();

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
    for (const { sessionId, events } of opts.completionEvents()) {
      if (!seeded(sessionId)) {
        for (const e of events) {
          foldTurnText(e);
          scannedSeqs.set(sessionId, e.seq);
        }
        seed(
          sessionId,
          events.map((e) => e.seq),
        );
        continue;
      }
      const through = scannedSeqs.get(sessionId) ?? 0;
      for (const e of events) {
        if (e.seq <= through) {
          if (e.type === "turn.recap") foldTurnText(e);
          if (!notifyable(e) || seqSeen(sessionId, e.seq)) continue;
        } else {
          /* Fold even a seen seq — the replay carries recap text the done
             event's excerpt needs, and a live mount may have missed it. */
          foldTurnText(e);
          scannedSeqs.set(sessionId, e.seq);
          if (seqSeen(sessionId, e.seq)) continue;
        }
        const n = notificationForEvent(e, ctxFor());
        if (!n) {
          /* Terminal-quiet events account once: cancelled turns, and any
             notifyable from an employee muted at check time — the moment
             was intentionally silent, so unmuting must not replay the
             past. Any other null is an unmapped conversation: the
             engineRef write can still land, so leave it for the next
             check. */
          if (
            e.type === "turn.completed" &&
            e.payload.stopReason === "cancelled"
          ) {
            recordSeq(sessionId, e.seq);
            continue;
          }
          if (notifyable(e)) {
            const ctx = ctxFor();
            const c = conversationOf(e.sessionId, ctx);
            if (c && employeeOf(c, ctx)?.muted) recordSeq(sessionId, e.seq);
          }
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
    /* Fold before the notifyable gate — deltas aren't attention-worthy
       but the done banner's excerpt is built from them (#561). */
    foldTurnText(e);
    if (!notifyable(e)) return;
    const n = notificationForEvent(e, ctxFor());
    if (!n) {
      // A mapped conversation means the event classified as uninteresting
      // (e.g. cancelled turn) — only an unmapped one is worth retrying, since
      // the relay write may land just behind a fast engine's events.
      const c = conversationOf(e.sessionId, opts.context());
      if (c) {
        /* Muted at delivery time — the moment stays silent for good, so the
           state check never reposts it after an unmute. An open ask stays
           owed instead: it still needs an answer once unmuted. */
        if (e.type !== "request.opened" && employeeOf(c, opts.context())?.muted)
          recordSeq(e.sessionId, e.seq);
        return;
      }
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
            const retry = notificationForEvent(e, ctxFor());
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
