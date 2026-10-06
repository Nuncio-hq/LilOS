/**
 * #572 — which engine sessions earn a live `sessionFeed`.
 *
 * Boot used to attach a feed for every conversation with an `engineRef`:
 * 31 sessions meant 31 `events.since` replays (~2.8 MB) and every feed —
 * with its folded model — stayed resident forever.
 *
 * The feed socket broadcasts every engine event to every peer, watched or
 * not, so the cheap truth a watch needs — is this session running? does it
 * have an open ask? is it closed? — folds off live frames without replay.
 * Relay rows seed it: `conversations.list` (`state === "active"`) and
 * `asks.list` are re-pulled on every connect, so the seed is fresh truth at
 * exactly the moments broadcast history can't be (boot, reconnect).
 *
 * Feeds attach for the open thread and for sessions that are running or
 * need the user; everything else renders off relay rows. Leaving the set —
 * turn ended, ask resolved, conversation archived or closed, thread
 * navigated away — releases the feed so the engine log can GC.
 */
import type { SessionFeedState, SessionModel } from "@lilos/client-runtime";
import type { Ask, Conversation } from "@lilos/contracts/app";
import type { EngineEvent, EngineRequest } from "@lilos/contracts/engine";
import type { ReadableAtom, WritableAtom } from "nanostores";

/** The broadcast-folded truth for one session — no replay needed. */
export interface SessionSignal {
  /** A turn is in flight (turn.started seen, no completion since). */
  running: boolean;
  /** Broadcast-known session life — overrides a stale relay row. */
  life?: "open" | "closed";
  /** Open engine requests by requestId — the count an approvals badge shows. */
  openRequests: ReadonlyMap<string, EngineRequest>;
}

/**
 * Fold one live engine event into a session's signal. Returns the SAME
 * object when nothing changed — signal subscribers only fire on real moves.
 * `undefined` means the session has never been heard from.
 */
export function foldSessionSignal(
  sig: SessionSignal | undefined,
  e: EngineEvent,
): SessionSignal | undefined {
  switch (e.type) {
    case "turn.started":
      /* A session running a turn is open by definition — clears a stale
         closed bit too (a suspended session resuming emits session.started
         first, but don't depend on the pair arriving in order). */
      return { ...ensure(sig), running: true, life: "open" };
    case "turn.completed":
      return sig?.running === false || sig === undefined
        ? sig
        : { ...sig, running: false };
    case "request.opened": {
      const cur = ensure(sig);
      if (cur.openRequests.has(e.payload.requestId)) return sig;
      const openRequests = new Map(cur.openRequests);
      openRequests.set(e.payload.requestId, e.payload.request);
      return { ...cur, openRequests };
    }
    case "request.resolved": {
      if (!sig?.openRequests.has(e.payload.requestId)) return sig;
      const openRequests = new Map(sig.openRequests);
      openRequests.delete(e.payload.requestId);
      return { ...sig, openRequests };
    }
    case "session.started":
      return sig?.life === "open" ? sig : { ...ensure(sig), life: "open" };
    case "session.state": {
      const state = e.payload.state;
      const cur = ensure(sig);
      if (state === "closed") return { ...cur, running: false, life: "closed" };
      if (state === "idle")
        return cur.running ? { ...cur, running: false } : sig;
      if (state === "running")
        return cur.running ? sig : { ...cur, running: true };
      if (state === "error")
        return cur.running ? { ...cur, running: false } : sig;
      return sig;
    }
    default:
      return sig;
  }
}

const ensure = (sig: SessionSignal | undefined): SessionSignal =>
  sig ?? { running: false, openRequests: new Map() };

export interface SessionWatchDeps {
  conversations: ReadableAtom<readonly Conversation[]>;
  asks: ReadableAtom<readonly Ask[]>;
  /** The conversation open in the thread panel, if any. */
  openConversationId: ReadableAtom<string | undefined>;
  sessionFeed: (sessionId: string) => WritableAtom<SessionFeedState>;
  sessionModel: (sessionId: string) => ReadableAtom<SessionModel>;
  /** Drop the session's feed atom + pending resyncs (EngineClient.releaseSession). */
  releaseSession: (sessionId: string) => void;
  /** Live broadcast events for every session (EngineClient.onEvent). */
  onEvent: (fn: (e: EngineEvent) => void) => () => void;
  /** Outputs — module atoms the watcher publishes into. */
  signals: WritableAtom<Record<string, SessionSignal>>;
  /** sid -> a feed is attached/wanted (#572): dm.tsx's "pending" gate. */
  watched: WritableAtom<Record<string, boolean>>;
  models: WritableAtom<Record<string, SessionModel>>;
  attached: WritableAtom<Record<string, boolean>>;
  /**
   * Sessions running when this client last saw them (persisted across
   * reloads by the caller). A turn that completed in the reload gap owes a
   * "done" notification, but the signal fold only saw the gap's far side —
   * the row already reads idle. Each member earns a one-shot attach: the
   * replay surfaces the missed completion, then the reconcile releases the
   * feed. Consumed the moment the feed answers (synced or terminal error).
   */
  previouslyRunning?: ReadonlySet<string>;
}

interface Entry {
  running: boolean;
  life?: "open" | "closed";
  /** request.opened seen on the broadcast, minus request.resolved. */
  feedRequests: Map<string, EngineRequest>;
  /** Open relay asks seeded for this session (asks.list / ask events). */
  askRequests: Map<string, EngineRequest>;
}

const emptyEntry = (): Entry => ({
  running: false,
  feedRequests: new Map(),
  askRequests: new Map(),
});

/**
 * Keeps feed subscriptions scoped to the conversations that need them.
 * Pure control loop: atoms in, `sessionFeed`/`releaseSession` calls out —
 * tests drive it with plain atoms and a stub engine surface.
 */
export class SessionWatch {
  private readonly entries = new Map<string, Entry>();
  /* Last conversation row object per sid: relay rows are immutable, so an
     unchanged object means the row is stale — broadcast truth then wins and
     the stale row never re-asserts over it. */
  private readonly convRows = new Map<string, Conversation>();
  /* Last ask row object per ask id — same stale-row shield for asks. */
  private readonly askRows = new Map<string, Ask>();
  private readonly convById = new Map<string, Conversation>();
  private readonly feedSubs = new Map<string, () => void>();
  private readonly latest = new Map<
    string,
    { feed?: SessionFeedState; model?: SessionModel }
  >();
  private stopFns: Array<() => void> = [];
  /* `previouslyRunning` not yet answered by a feed — membership in the
     watch set until the attach reports back. */
  private readonly staleCheck: Set<string>;

  constructor(private readonly deps: SessionWatchDeps) {
    this.staleCheck = new Set(deps.previouslyRunning ?? []);
  }

  start(): () => void {
    /* Atoms notify their current value on subscribe — the boot pass runs
       through the same path as every later change. */
    this.stopFns = [
      this.deps.conversations.subscribe(() => this.onConversations()),
      this.deps.asks.subscribe(() => this.onAsks()),
      this.deps.openConversationId.subscribe(() => this.evaluate()),
      this.deps.onEvent((e) => this.onEngineEvent(e)),
    ];
    return () => this.stop();
  }

  stop(): void {
    for (const fn of this.stopFns) fn();
    this.stopFns = [];
    for (const stop of this.feedSubs.values()) stop();
    this.feedSubs.clear();
  }

  /* ------------------------- inputs ------------------------- */

  private onConversations(): void {
    const convs = this.deps.conversations.get();
    this.convById.clear();
    for (const c of convs) this.convById.set(c.id, c);
    for (const c of convs) {
      const sid = c.engineRef;
      if (!sid) continue;
      if (this.convRows.get(sid) === c) continue; // unchanged row object
      this.convRows.set(sid, c);
      const e = this.entry(sid);
      e.running = c.state === "active";
      e.life = c.life;
      /* Re-seed the ask side too — an ask can predate the engineRef bind
         (a conv gains it on the row that opens its session). */
      this.seedAsks(sid, c.id);
      this.publish(sid);
    }
    this.evaluate();
  }

  private onAsks(): void {
    const asks = this.deps.asks.get();
    const seen = new Set<string>();
    for (const a of asks) {
      seen.add(a.id);
      if (this.askRows.get(a.id) === a) continue; // unchanged row object
      this.askRows.set(a.id, a);
      const sid = this.sidForConv(a.conversationId);
      if (!sid) continue;
      const e = this.entry(sid);
      if (a.state === "open") e.askRequests.set(a.requestId, a.request);
      else {
        e.askRequests.delete(a.requestId);
        e.feedRequests.delete(a.requestId);
      }
      this.publish(sid);
    }
    /* A vanished ask row (channel dropped) frees its request too. */
    for (const [id, a] of this.askRows) {
      if (seen.has(id)) continue;
      this.askRows.delete(id);
      const sid = this.sidForConv(a.conversationId);
      if (!sid) continue;
      const e = this.entries.get(sid);
      if (e?.askRequests.delete(a.requestId)) this.publish(sid);
    }
    this.evaluate();
  }

  private onEngineEvent(e: EngineEvent): void {
    const sid = e.sessionId;
    const entry = this.entries.get(sid);
    const cur: SessionSignal | undefined = entry
      ? this.compose(entry)
      : undefined;
    const next = foldSessionSignal(cur, e);
    if (next === cur) return;
    /* The fold works on the published shape; write the pieces back. */
    const target = this.entry(sid);
    target.running = next?.running ?? false;
    target.life = next?.life;
    if (e.type === "request.opened")
      target.feedRequests.set(e.payload.requestId, e.payload.request);
    else if (e.type === "request.resolved") {
      target.feedRequests.delete(e.payload.requestId);
      target.askRequests.delete(e.payload.requestId);
    }
    this.publish(sid);
    this.evaluate();
  }

  /* ------------------------- signals ------------------------- */

  private entry(sid: string): Entry {
    let e = this.entries.get(sid);
    if (!e) {
      e = emptyEntry();
      this.entries.set(sid, e);
    }
    return e;
  }

  private compose(e: Entry): SessionSignal {
    return {
      running: e.running,
      life: e.life,
      openRequests: new Map([...e.askRequests, ...e.feedRequests]),
    };
  }

  private publish(sid: string): void {
    const e = this.entries.get(sid);
    const next = { ...this.deps.signals.get() };
    /* Nothing meaningful → drop the entry entirely so the atom stays a
       tight map of sessions worth rendering state for. */
    if (
      !e ||
      (!e.running &&
        e.life === undefined &&
        e.askRequests.size === 0 &&
        e.feedRequests.size === 0)
    ) {
      this.entries.delete(sid);
      if (!(sid in next)) return;
      delete next[sid];
      this.deps.signals.set(next);
      return;
    }
    next[sid] = this.compose(e);
    this.deps.signals.set(next);
  }

  private sidForConv(conversationId: string): string | undefined {
    return this.convById.get(conversationId)?.engineRef ?? undefined;
  }

  private seedAsks(sid: string, conversationId: string): void {
    const e = this.entry(sid);
    e.askRequests.clear();
    for (const a of this.deps.asks.get()) {
      if (a.conversationId !== conversationId || a.state !== "open") continue;
      e.askRequests.set(a.requestId, a.request);
    }
  }

  /* ------------------------- the watch set ------------------------- */

  private desired(): Set<string> {
    const open = this.deps.openConversationId.get();
    const want = new Set<string>();
    for (const c of this.deps.conversations.get()) {
      const sid = c.engineRef;
      if (!sid) continue;
      /* The open thread always earns its feed — user intent trumps
         eligibility, so an archived or suspended session still replays
         while it's on screen. */
      if (c.id === open) {
        want.add(sid);
        continue;
      }
      if (c.archived) continue;
      const e = this.entries.get(sid);
      const wantsStale = this.staleCheck.has(sid);
      /* A closed conversation bows out — unless it owes one last look at
         what its running turn finished with (the reload-gap case). */
      if (
        (c.state === "closed" || (e?.life ?? c.life) === "closed") &&
        !wantsStale
      )
        continue;
      if (
        e?.running ||
        (e && e.askRequests.size + e.feedRequests.size > 0) ||
        wantsStale
      )
        want.add(sid);
    }
    return want;
  }

  private evaluate(): void {
    const want = this.desired();
    for (const [sid, stop] of [...this.feedSubs]) {
      if (want.has(sid)) continue;
      stop();
      this.feedSubs.delete(sid);
      this.latest.delete(sid);
      this.deps.releaseSession(sid);
    }
    for (const sid of want) if (!this.feedSubs.has(sid)) this.attach(sid);
    const w = this.deps.watched.get();
    const next: Record<string, boolean> = {};
    let changed = false;
    for (const sid of this.feedSubs.keys()) {
      next[sid] = true;
      if (w[sid] !== true) changed = true;
    }
    if (!changed && Object.keys(w).length !== Object.keys(next).length)
      changed = true;
    if (changed) this.deps.watched.set(next);
  }

  private attach(sid: string): void {
    const latest: { feed?: SessionFeedState; model?: SessionModel } = {};
    this.latest.set(sid, latest);
    const model = this.deps.sessionModel(sid);
    const unModel = model.subscribe((m) => {
      latest.model = m;
      if (this.deps.models.get()[sid] !== m)
        this.deps.models.set({ ...this.deps.models.get(), [sid]: m });
      this.reconcile(sid);
    });
    const unFeed = this.deps.sessionFeed(sid).subscribe((f) => {
      latest.feed = f;
      /* The model computed emits one listener-queue slot AFTER this
         callback (feed listeners run `run` → unFeed → unModel), so
         `latest.model` written by unModel is one emission stale. Live
         ticks hide it — the stale model still says running — but a boot
         replay folds the whole log into a single feed.set and the stale
         model is the virgin fold (no turns, no requests): reconcile
         would release the feed while the waiting model sits in queue.
         `get()` returns the value consistent with THIS feed state. */
      latest.model = model.get();
      const attached = f.synced || f.error !== undefined || f.coverageSeq > 0;
      if (this.deps.attached.get()[sid] !== attached)
        this.deps.attached.set({
          ...this.deps.attached.get(),
          [sid]: attached,
        });
      this.reconcile(sid);
      /* First answer settles the one-shot — after reconcile, so a synced
         model's truth (still running) lands before the re-evaluation;
         error → the log is gone, stop asking. */
      if ((f.synced || f.error !== undefined) && this.staleCheck.delete(sid))
        this.evaluate();
    });
    this.feedSubs.set(sid, () => {
      unModel();
      unFeed();
      const models = { ...this.deps.models.get() };
      delete models[sid];
      this.deps.models.set(models);
      const attached = { ...this.deps.attached.get() };
      delete attached[sid];
      this.deps.attached.set(attached);
    });
  }

  /* Once a feed has synced, the reduced model is the truth: it fixes a
     stale seeded flag (a row that still said active after the turn ended)
     and open requests the broadcast never showed us (resolved in a socket
     gap — or an ask row the relay never got to update). Only then does the
     session leave the watch set. */
  private reconcile(sid: string): void {
    const l = this.latest.get(sid);
    if (!l?.feed?.synced || !l.model) return;
    const e = this.entry(sid);
    const running = l.model.live !== undefined;
    const reqs = new Map(
      l.model.openRequests.map((r) => [r.requestId, r.request]),
    );
    const sameReqs = (m: Map<string, EngineRequest>) =>
      m.size === reqs.size && [...reqs.keys()].every((id) => m.has(id));
    if (
      e.running === running &&
      sameReqs(e.feedRequests) &&
      sameReqs(e.askRequests)
    )
      return;
    e.running = running;
    e.feedRequests = reqs;
    e.askRequests = new Map(reqs);
    this.publish(sid);
    this.evaluate();
  }
}
