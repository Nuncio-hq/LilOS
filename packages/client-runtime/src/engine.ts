import {
  type DescribeResult,
  ENGINE_EVENT_TYPES,
  EngineEvent,
  EVENT_METHOD,
  type EventsSinceResult,
  type OpenRequest,
  type SessionSnapshot,
} from "@lilos/contracts/engine";
import { atom, type WritableAtom } from "nanostores";
import { mergeFeedEvents } from "./feed-merge";
import {
  defaultSocketFactory,
  type RelaySocket,
  SOCKET_OPEN,
  type SocketFactory,
} from "./socket";

export type EngineConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export class EngineError extends Error {
  readonly code?: string;
  readonly data?: unknown;
  constructor(message: string, code?: string, data?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.data = data;
  }
}

export interface EngineClientOptions {
  /** ws:// or wss:// endpoint speaking the engine protocol (harness, engine-fake, …). */
  url: string;
  socketFactory?: SocketFactory;
  autoReconnect?: boolean;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  onFatalError?: (error: EngineError) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4_000;

/** Live state for one engine session: replayed event log + open requests + snapshot. */
export interface SessionFeedState {
  sessionId: string;
  /** True after the first events.since replay completed. */
  synced: boolean;
  latestSeq: number;
  /**
   * Contiguous coverage watermark: every event with seq <= coverageSeq is
   * in `events`. `latestSeq` can outrun it — live notifications land as they
   * arrive, so a feed created before the socket opens sees mid-turn events
   * and jumps `latestSeq` past a prefix it never fetched. `events.since`
   * replays must start at this watermark or that prefix is lost for good.
   */
  coverageSeq: number;
  events: EngineEvent[];
  openRequests: OpenRequest[];
  snapshot?: SessionSnapshot;
  /**
   * Why the working transcript can't be shown right now (#28 AC-2):
   * feed socket down, session unknown to the engine, or a replay failure.
   * Cleared on the next successful resync.
   */
  error?: string;
  /** #431: the engine's log is capped — the transcript's retained head is
     all that exists (events.since answered `truncated`). */
  historyTrimmed?: boolean;
}

/**
 * Client for the engine protocol (packages/contracts/src/engine). Transport
 * owner — same shape as RelayClient: one socket, reconnect + per-session
 * resync live here so views never compete to redial. There is no handshake;
 * `connect` runs `describe` and stores the result (capabilities gate UI).
 */
export class EngineClient {
  readonly state: WritableAtom<EngineConnectionState> = atom("idle");
  readonly description: WritableAtom<DescribeResult | undefined> =
    atom(undefined);

  private readonly options: Required<
    Pick<
      EngineClientOptions,
      | "autoReconnect"
      | "reconnectMinDelayMs"
      | "reconnectMaxDelayMs"
      | "connectTimeoutMs"
      | "requestTimeoutMs"
    >
  > &
    EngineClientOptions;

  private socket: RelaySocket | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<
    string | number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly feeds = new Map<string, WritableAtom<SessionFeedState>>();
  /* #179: a failed `events.since` mustn't brick a feed while the socket
     stays up — transient failures retry with backoff (bounded), then the
     error note stands. */
  private readonly resyncRetries = new Map<
    WritableAtom<SessionFeedState>,
    { attempts: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private manualClose = false;
  private connectPromise: Promise<DescribeResult> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  constructor(options: EngineClientOptions) {
    this.options = {
      autoReconnect: true,
      reconnectMinDelayMs: DEFAULT_MIN_DELAY_MS,
      reconnectMaxDelayMs: DEFAULT_MAX_DELAY_MS,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      ...options,
    };
  }

  get connected(): boolean {
    return this.state.get() === "ready";
  }

  connect(): Promise<DescribeResult> {
    if (!this.connectPromise) {
      this.connectPromise = this.openSocket()
        .then(() => this.request<DescribeResult>("describe", {}))
        .then((d) => {
          this.description.set(d);
          this.state.set("ready");
          this.reconnectAttempt = 0;
          void this.resyncFeeds();
          return d;
        })
        .catch((error: unknown) => {
          this.dropSocket(
            error instanceof EngineError
              ? error
              : new EngineError("connect failed", "connect_failed"),
          );
          this.connectPromise = undefined;
          throw error;
        });
    }
    return this.connectPromise;
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const entry of this.resyncRetries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.resyncRetries.clear();
    this.socket?.close();
    this.dropSocket(new EngineError("engine socket closed", "socket_closed"));
    this.connectPromise = undefined;
    this.state.set("closed");
  }

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new EngineError("engine not connected", "not_connected");
    }
    const id = `e${this.nextRequestId++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`request ${method} timed out`, "timeout"));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket?.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      );
    });
  }

  /** Subscribe to every engine event notification. Unsubscribe = return fn. */
  onEvent(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Watch one engine session: `events.since` replay lands in the atom, live
   * notifications append in seq order, and a socket drop resyncs from the
   * watermark on reconnect.
   */
  sessionFeed(sessionId: string): WritableAtom<SessionFeedState> {
    let feed = this.feeds.get(sessionId);
    if (!feed) {
      feed = atom<SessionFeedState>({
        sessionId,
        synced: false,
        latestSeq: 0,
        coverageSeq: 0,
        events: [],
        openRequests: [],
      });
      this.feeds.set(sessionId, feed);
      if (this.state.get() === "ready") {
        /* The failure is recorded on the feed (+retry) — nothing else
           consumes the rejection. */
        void this.resyncFeed(feed).catch(() => {});
      }
    }
    return feed;
  }

  /* ------------------------------ internals ----------------------------- */

  private openSocket(): Promise<void> {
    this.state.set(this.description.get() ? "reconnecting" : "connecting");
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(
      this.options.url,
    );
    this.socket = socket;
    this.attachSocketListeners(socket);
    return this.waitForOpen(socket);
  }

  private waitForOpen(socket: RelaySocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EngineError("engine connect timed out", "timeout"));
      }, this.options.connectTimeoutMs);
      let settled = false;
      const settle = (fn: () => void) => () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      socket.addEventListener(
        "open",
        settle(() => resolve()),
      );
      socket.addEventListener(
        "error",
        settle(() =>
          reject(new EngineError("engine socket error", "socket_error")),
        ),
      );
      socket.addEventListener(
        "close",
        settle(() =>
          reject(new EngineError("engine socket closed", "socket_closed")),
        ),
      );
    });
  }

  private attachSocketListeners(socket: RelaySocket): void {
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : undefined;
      if (raw === undefined) return;
      void this.handleFrame(raw);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.handleSocketClose();
    });
    socket.addEventListener("error", () => {
      /* close follows */
    });
  }

  private async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (frame.id !== undefined) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) {
        entry.reject(
          new EngineError(
            frame.error.message ?? "engine error",
            frame.error.code !== undefined
              ? String(frame.error.code)
              : "rpc_error",
            frame.error.data,
          ),
        );
      } else {
        entry.resolve(frame.result);
      }
      return;
    }
    if (frame.method !== EVENT_METHOD) return;
    const event = EngineEvent.safeParse(frame.params);
    if (!event.success) return;
    this.dispatchEvent(event.data);
  }

  private dispatchEvent(event: EngineEvent): void {
    const feed = this.feeds.get(event.sessionId);
    if (feed) this.applyFeedEvent(feed, event);
    for (const fn of this.listeners) fn(event);
  }

  private applyFeedEvent(
    feed: WritableAtom<SessionFeedState>,
    event: EngineEvent,
  ): void {
    const state = feed.get();
    if (event.seq <= state.latestSeq) return; // replay overlap / dedupe
    const next: SessionFeedState = {
      ...state,
      latestSeq: event.seq,
      // In-order arrival extends contiguous coverage; a skipped seq stalls
      // the watermark (the next resync refetches the gap) instead of lying.
      coverageSeq:
        event.seq === state.coverageSeq + 1 ? event.seq : state.coverageSeq,
      events: [...state.events, event],
    };
    if (event.type === "request.opened") {
      const { turnId, requestId, request } = event.payload;
      next.openRequests = [
        ...state.openRequests.filter((r) => r.requestId !== requestId),
        { requestId, turnId, request, seq: event.seq },
      ];
    } else if (event.type === "request.resolved") {
      const { requestId } = event.payload;
      next.openRequests = state.openRequests.filter(
        (r) => r.requestId !== requestId,
      );
    } else if (
      event.type === "session.state" ||
      event.type === "turn.started"
    ) {
      /* snapshot updated lazily below */
    }
    feed.set(next);
    /* #400: a skipped seq means this socket missed a window while connected
       (attach lag, a hiccup in the live broadcast) — the feed's open
       requests / turn text / completions now have a hole nothing re-reads
       until the next reconnect. Refetch it instead of stalling forever. */
    if (
      state.synced &&
      event.seq > state.coverageSeq + 1 &&
      this.state.get() === "ready"
    )
      this.resyncFeedOnce(feed);
  }

  /* One refetch per feed at a time — a stalled run of live events queues
     no pile of overlapping events.since calls; whichever lands last covers
     the newest gap. */
  private readonly resyncInFlight = new Set<WritableAtom<SessionFeedState>>();

  private resyncFeedOnce(feed: WritableAtom<SessionFeedState>): void {
    if (this.resyncInFlight.has(feed)) return;
    this.resyncInFlight.add(feed);
    void this.resyncFeed(feed)
      .catch(() => {})
      .finally(() => this.resyncInFlight.delete(feed));
  }

  private async resyncFeeds(): Promise<void> {
    await Promise.all(
      [...this.feeds.values()].map((feed) =>
        this.resyncFeed(feed).catch(() => {}),
      ),
    );
  }

  private async resyncFeed(
    feed: WritableAtom<SessionFeedState>,
  ): Promise<void> {
    const state = feed.get();
    try {
      /* A feed that never synced replays from 0, not from the live
         watermark: coverageSeq only advances in order, so mid-turn events
         landing before the first resync can't skip the prefix — turn text,
         plans, requests (#180 AC-1). */
      let res = await this.request<EventsSinceResult>("events.since", {
        sessionId: state.sessionId,
        after: state.coverageSeq,
      });
      /* #431: a `truncated` answer on a nonzero watermark means the engine
         dropped frames inside the range we asked to patch — the coverage
         watermark sits in a hole. Refetch the retained log from 0; the merge
         still keeps live frames the hole never covered. */
      if (res.truncated && state.coverageSeq > 0) {
        res = await this.request<EventsSinceResult>("events.since", {
          sessionId: state.sessionId,
          after: 0,
        });
      }
      // Re-read: live events can land while the replay is in flight. The
      // replay is authoritative only through `res.latestSeq` — merging onto
      // the fresh state (not the pre-await snapshot) keeps those live events
      // and the watermark they already moved.
      const cur = feed.get();
      const merged = mergeFeedEvents(cur.events, res.events);
      // `res.openRequests` is the set as of `res.latestSeq`; live events past
      // that watermark already folded into `cur` — re-fold them on top of the
      // replayed set so an ask that opened mid-replay isn't dropped.
      const openRequests = [...res.openRequests];
      const openIds = new Set(openRequests.map((r) => r.requestId));
      for (const e of merged) {
        if (e.seq <= res.latestSeq) continue;
        if (e.type === "request.opened") {
          const { turnId, requestId, request } = e.payload;
          if (openIds.has(requestId)) continue;
          openIds.add(requestId);
          openRequests.push({ requestId, turnId, request, seq: e.seq });
        } else if (e.type === "request.resolved") {
          const { requestId } = e.payload;
          const i = openRequests.findIndex((r) => r.requestId === requestId);
          if (i >= 0) openRequests.splice(i, 1);
          openIds.delete(requestId);
        }
      }
      feed.set({
        sessionId: cur.sessionId,
        synced: true,
        latestSeq: Math.max(res.latestSeq, cur.latestSeq),
        coverageSeq: Math.max(res.latestSeq, cur.coverageSeq),
        events: merged,
        openRequests,
        /* #327: stamp the point the snapshot was captured at — live
           frames keep landing on `events` without refreshing it, so the
           fold (turn-model) reads `atSeq` to tell a current snapshot
           from a stale one. */
        snapshot: {
          ...res.snapshot,
          atSeq: res.latestSeq,
        } as SessionSnapshot,
        error: undefined,
        /* Sticky: a clean resync mustn't clear it — the trimmed head is
           still missing even though this window answered untruncated. */
        historyTrimmed: cur.historyTrimmed || res.truncated,
      });
      const pending = this.resyncRetries.get(feed);
      if (pending?.timer) clearTimeout(pending.timer);
      this.resyncRetries.delete(feed);
    } catch (error) {
      feed.set({
        ...feed.get(),
        error: feedErrorText(error),
      });
      /* #179: transient failures (engine link blip, request timeout) retry
         with backoff — the socket staying up never re-triggers a resync on
         its own, and without this the pre-reload log (e.g. subagent rows)
         is lost for good. A gone session is terminal: its note stands. */
      if (isTransientFeedError(error)) this.scheduleResyncRetry(feed);
      throw error;
    }
  }

  private scheduleResyncRetry(feed: WritableAtom<SessionFeedState>): void {
    const entry = this.resyncRetries.get(feed) ?? { attempts: 0 };
    if (entry.attempts >= 5) return;
    entry.attempts += 1;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        this.resyncRetries.delete(feed);
        /* Not ready yet — the reconnect path's resyncFeeds covers it. */
        if (this.state.get() === "ready")
          void this.resyncFeed(feed).catch(() => {});
      },
      Math.min(2_000 * 2 ** (entry.attempts - 1), 15_000),
    );
    this.resyncRetries.set(feed, entry);
  }

  private dropSocket(_error: EngineError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new EngineError("engine socket closed", "socket_closed"));
    }
    this.pending.clear();
    this.socket = undefined;
  }

  private handleSocketClose(): void {
    const stillHandshaking = this.state.get() === "connecting";
    this.dropSocket(new EngineError("engine socket closed", "socket_closed"));
    if (stillHandshaking || this.manualClose || !this.options.autoReconnect) {
      if (!stillHandshaking) this.state.set("closed");
      this.connectPromise = undefined;
      return;
    }
    for (const feed of this.feeds.values()) {
      feed.set({ ...feed.get(), synced: false });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    this.state.set("reconnecting");
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectMinDelayMs * 2 ** this.reconnectAttempt++,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectPromise = undefined;
      void this.connect().catch((error: unknown) => {
        this.options.onFatalError?.(
          error instanceof EngineError
            ? error
            : new EngineError("reconnect failed", "connect_failed"),
        );
      });
    }, delay);
  }
}

/** #179: a gone session's replay error is terminal; anything else retries. */
function isTransientFeedError(error: unknown): boolean {
  const code =
    error instanceof EngineError ? (error.code ?? "") : String(error);
  return !code.includes("session_not_found") && !code.includes("-32001");
}

/** Why a session feed can't replay — phrased for the thread panel. */
function feedErrorText(error: unknown): string {
  const code =
    error instanceof EngineError ? (error.code ?? "") : String(error);
  if (code === "not_connected" || code === "socket_closed")
    return "the engine feed is disconnected (harness down or restarting)";
  if (code.includes("session_not_found") || code === "-32001")
    return "the engine no longer has this session (its log was evicted or the process restarted)";
  return `transcript replay failed: ${error instanceof Error ? error.message : String(error)}`;
}
