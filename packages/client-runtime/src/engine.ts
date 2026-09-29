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
        void this.resyncFeed(feed);
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
      const res = await this.request<EventsSinceResult>("events.since", {
        sessionId: state.sessionId,
        after: state.coverageSeq,
      });
      // Re-read: live events can land while the replay is in flight. The
      // replay is authoritative only through `res.latestSeq` — merging onto
      // the fresh state (not the pre-await snapshot) keeps those live events
      // and the watermark they already moved.
      const cur = feed.get();
      const merged = [...cur.events];
      for (const e of res.events) {
        if (!merged.some((m) => m.seq === e.seq)) merged.push(e);
      }
      merged.sort((a, b) => a.seq - b.seq);
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
        snapshot: res.snapshot,
        error: undefined,
      });
    } catch (error) {
      feed.set({
        ...feed.get(),
        error: feedErrorText(error),
      });
      throw error;
    }
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

/** ids used by tests to assert events the client accepted. */
export const ENGINE_EVENT_NAMES = ENGINE_EVENT_TYPES;

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
