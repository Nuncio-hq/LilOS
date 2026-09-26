import {
  APP_PROTOCOL_VERSION,
  type AppChannel,
  type AppMessage,
  ChannelSnapshotEvent,
  ChannelSyncedEvent,
  type Conversation,
  ConversationUpdatedEvent,
  type Employee,
  JsonRpcNotification,
  JsonRpcResponse,
  MessageCreatedEvent,
  type RequestId,
  type RpcError,
  type WelcomeResult,
} from "@lilos/contracts/app";
import { atom, type WritableAtom } from "nanostores";
import {
  defaultSocketFactory,
  type RelaySocket,
  SOCKET_OPEN,
  type SocketFactory,
} from "./socket";

export type RelayConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export class RelayError extends Error {
  readonly code?: string;
  readonly data?: unknown;
  constructor(message: string, code?: string, data?: unknown) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.data = data;
  }
}

export interface ChannelMessagesState {
  channelId: string;
  /** True once the replay/snapshot window closed (`channel.synced`). */
  synced: boolean;
  /** Highest message seq applied. */
  lastSeq: number;
  /** Seq-ordered visible messages. */
  messages: AppMessage[];
}

export interface RelayClientOptions {
  /** ws:// or wss:// relay endpoint (path included, e.g. ws://127.0.0.1:4577/ws). */
  url: string;
  /** Per-install token (relay writes it to <home>/relay-token on first run). */
  token: string;
  socketFactory?: SocketFactory;
  protocolVersion?: number;
  client?: { name?: string; version?: string };
  /** Reconnect with capped exponential backoff (default on). */
  autoReconnect?: boolean;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Fatal handshake failures (version mismatch, bad token) land here. */
  onFatalError?: (error: RelayError) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4_000;

/**
 * One transport owner per relay (T3 Code `connection-runtime` pattern):
 * reconnect, hello handshake, resubscribe, and replay all live here so views
 * never compete to redial.
 *
 * Reconnect replay follows Hermes `json-rpc-gateway.ts`: per-channel seq
 * watermarks drive `channel.subscribe { afterSeq }`; while a subscription
 * catches up, live `message.created` frames are parked, then flushed through
 * a seq gate so nothing is dispatched twice or out of order. A changed
 * `instanceId` (relay restart) invalidates watermarks → snapshot resync.
 */
export class RelayClient {
  readonly state: WritableAtom<RelayConnectionState> = atom("idle");
  readonly employees: WritableAtom<Employee[]> = atom([]);
  readonly channels: WritableAtom<AppChannel[]> = atom([]);
  readonly conversations: WritableAtom<Conversation[]> = atom([]);

  private readonly options: Required<
    Pick<
      RelayClientOptions,
      | "protocolVersion"
      | "autoReconnect"
      | "reconnectMinDelayMs"
      | "reconnectMaxDelayMs"
      | "connectTimeoutMs"
      | "requestTimeoutMs"
    >
  > &
    RelayClientOptions;

  private socket: RelaySocket | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<
    RequestId,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly watermarks = new Map<string, number>();
  private readonly catchingUp = new Set<string>();
  private readonly parked = new Map<string, AppMessage[]>();
  private readonly channelStates = new Map<
    string,
    WritableAtom<ChannelMessagesState>
  >();
  private readonly subscribedChannels = new Set<string>();
  private serverInstanceId: string | undefined;
  private everConnected = false;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private connectPromise: Promise<WelcomeResult> | undefined;

  constructor(options: RelayClientOptions) {
    this.options = {
      protocolVersion: options.protocolVersion ?? APP_PROTOCOL_VERSION,
      autoReconnect: options.autoReconnect ?? true,
      reconnectMinDelayMs: options.reconnectMinDelayMs ?? DEFAULT_MIN_DELAY_MS,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...options,
    };
  }

  /**
   * Open the socket and complete `session.hello`. Rejects with a typed
   * RelayError (`code: "protocol_version_mismatch"` | "unauthenticated") on a
   * refused handshake — `error.data.update` names the side to update.
   */
  connect(): Promise<WelcomeResult> {
    if (this.connectPromise) return this.connectPromise;
    this.manualClose = false;
    this.connectPromise = this.openAndHello()
      .then((welcome) => {
        this.everConnected = true;
        this.reconnectAttempt = 0;
        this.state.set("ready");
        void this.resync();
        return welcome;
      })
      .catch((error: Error) => {
        this.connectPromise = undefined;
        throw error;
      });
    return this.connectPromise;
  }

  close(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.dropSocket(new RelayError("relay client closed", "closed"));
    this.connectPromise = undefined;
    this.state.set("closed");
  }

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new RelayError("relay not connected", "not_connected");
    }
    const id = `r${this.nextRequestId++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError(`request ${method} timed out`, "timeout"));
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

  /** Subscribe a channel and get its live message store. */
  channelMessages(channelId: string): WritableAtom<ChannelMessagesState> {
    let store = this.channelStates.get(channelId);
    if (!store) {
      store = atom<ChannelMessagesState>({
        channelId,
        synced: false,
        lastSeq: 0,
        messages: [],
      });
      this.channelStates.set(channelId, store);
    }
    if (!this.subscribedChannels.has(channelId)) {
      this.subscribedChannels.add(channelId);
      // Unawaited: a drop mid-subscribe rejects into resubscribe on reconnect.
      if (this.state.get() === "ready") {
        void this.subscribeChannel(channelId).catch(() => {});
      }
    }
    return store;
  }

  async unsubscribeChannel(channelId: string): Promise<void> {
    this.subscribedChannels.delete(channelId);
    this.catchingUp.delete(channelId);
    this.parked.delete(channelId);
    if (this.state.get() === "ready") {
      await this.request("channel.unsubscribe", { channelId });
    }
  }

  /* ------------------------------ internals ----------------------------- */

  private async openAndHello(): Promise<WelcomeResult> {
    this.state.set(this.everConnected ? "reconnecting" : "connecting");
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(
      this.options.url,
    );
    this.socket = socket;
    this.attachSocketListeners(socket);
    await this.waitForOpen(socket);
    try {
      const welcome = await this.request<WelcomeResult>("session.hello", {
        protocolVersion: this.options.protocolVersion,
        token: this.options.token,
        client: this.options.client,
      });
      if (
        this.serverInstanceId &&
        this.serverInstanceId !== welcome.instanceId
      ) {
        // Relay process restarted: old seq watermarks describe a numbering
        // that may no longer exist (Hermes replay_epoch rule) — resync fresh.
        this.watermarks.clear();
      }
      this.serverInstanceId = welcome.instanceId;
      return welcome;
    } catch (error) {
      try {
        socket.close(
          4000,
          error instanceof Error ? error.message : "hello failed",
        );
      } catch {
        // already closed
      }
      throw error;
    }
  }

  private waitForOpen(socket: RelaySocket): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new RelayError(
              `no WebSocket open within ${this.options.connectTimeoutMs} ms`,
              "connect_timeout",
            ),
          );
        }
      }, this.options.connectTimeoutMs);
      const done = (fn: () => void) => () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      socket.addEventListener(
        "open",
        done(() => resolve()),
      );
      socket.addEventListener(
        "error",
        done(() =>
          reject(
            new RelayError("WebSocket error before open", "connect_failed"),
          ),
        ),
      );
      socket.addEventListener(
        "close",
        done((event?: { code: number; reason: string }) =>
          reject(
            new RelayError(
              `WebSocket closed during handshake: code ${event?.code ?? "?"}`,
              "connect_failed",
            ),
          ),
        ),
      );
    });
  }

  private attachSocketListeners(socket: RelaySocket): void {
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const text = typeof event.data === "string" ? event.data : undefined;
      if (text !== undefined) this.handleFrame(text);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.handleSocketClose();
    });
    socket.addEventListener("error", () => {
      // 'close' follows; nothing to do here.
    });
  }

  private async resync(): Promise<void> {
    // Directory refresh runs every (re)connect: employees/channels/
    // conversations are read-model lists, not seq-replayed.
    await Promise.all([this.refreshDirectory(), this.resubscribeAll()]);
  }

  private async refreshDirectory(): Promise<void> {
    try {
      const [employees, channels, conversations] = await Promise.all([
        this.request<{ employees: Employee[] }>("employees.list", {}),
        this.request<{ channels: AppChannel[] }>("channels.list", {}),
        this.request<{ conversations: Conversation[] }>(
          "conversations.list",
          {},
        ),
      ]);
      this.employees.set(employees.employees);
      this.channels.set(channels.channels);
      this.conversations.set(conversations.conversations);
    } catch {
      // Directory refresh is best-effort on reconnect; stores keep stale data.
    }
  }

  private async resubscribeAll(): Promise<void> {
    // Per-channel failures (e.g. channel deleted while offline) leave that
    // channel unsynced but don't block the rest of the resync.
    await Promise.all(
      [...this.subscribedChannels].map((channelId) =>
        this.subscribeChannel(channelId).catch(() => {}),
      ),
    );
  }

  private async subscribeChannel(channelId: string): Promise<void> {
    this.catchingUp.add(channelId);
    this.setChannelSynced(channelId, false);
    const afterSeq = this.watermarks.get(channelId);
    try {
      await this.request("channel.subscribe", {
        channelId,
        ...(afterSeq !== undefined ? { afterSeq } : {}),
      });
    } catch (error) {
      this.catchingUp.delete(channelId);
      this.parked.delete(channelId);
      throw error;
    }
  }

  private handleFrame(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    // Route on raw keys, not the schema: z.object strips unknown fields, so a
    // malformed frame could match a branch its author didn't mean.
    const raw = parsed as Record<string, unknown>;
    if (raw.id !== undefined && ("result" in raw || "error" in raw)) {
      const asResponse = JsonRpcResponse.safeParse(parsed);
      if (asResponse.success)
        this.handleResponse(asResponse.data.id, asResponse.data);
      return;
    }
    if (typeof raw.method === "string") {
      const asNotification = JsonRpcNotification.safeParse(parsed);
      if (asNotification.success) {
        this.handleNotification(
          asNotification.data.method,
          asNotification.data.params ?? {},
        );
      }
    }
  }

  private handleResponse(
    id: RequestId,
    frame: { result?: unknown; error?: RpcError },
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.error) {
      const data = frame.error.data as { code?: string } | undefined;
      entry.reject(
        new RelayError(
          frame.error.message,
          data?.code ?? "rpc_error",
          frame.error.data,
        ),
      );
    } else {
      entry.resolve(frame.result);
    }
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    switch (method) {
      case "message.created": {
        const event = MessageCreatedEvent.parse(params);
        if (this.catchingUp.has(event.channelId)) {
          // Replay in flight (Hermes replayHold): park the live frame so it
          // can't dispatch ahead of, or duplicate, the gap events.
          const list = this.parked.get(event.channelId) ?? [];
          list.push(event.message);
          this.parked.set(event.channelId, list);
          return;
        }
        this.dispatchIfNewer(event.channelId, event.message);
        return;
      }
      case "channel.snapshot": {
        const event = ChannelSnapshotEvent.parse(params);
        const store = this.channelStates.get(event.channelId);
        this.watermarks.set(event.channelId, event.lastSeq);
        store?.set({
          channelId: event.channelId,
          synced: false,
          lastSeq: event.lastSeq,
          messages: [...event.messages].sort((a, b) => a.seq - b.seq),
        });
        return;
      }
      case "channel.synced": {
        const event = ChannelSyncedEvent.parse(params);
        this.catchingUp.delete(event.channelId);
        const parked = this.parked.get(event.channelId) ?? [];
        this.parked.delete(event.channelId);
        for (const message of parked) {
          this.dispatchIfNewer(event.channelId, message);
        }
        const wm = this.watermarks.get(event.channelId) ?? 0;
        if (event.lastSeq > wm)
          this.watermarks.set(event.channelId, event.lastSeq);
        this.setChannelSynced(event.channelId, true, event.lastSeq);
        return;
      }
      case "conversation.updated": {
        const event = ConversationUpdatedEvent.parse(params);
        const list = this.conversations.get();
        const idx = list.findIndex((c) => c.id === event.conversation.id);
        const next =
          idx === -1
            ? [...list, event.conversation]
            : list.map((c) =>
                c.id === event.conversation.id ? event.conversation : c,
              );
        this.conversations.set(next);
        return;
      }
    }
  }

  /** Dispatch only when seq advances the channel watermark (dedupe). */
  private dispatchIfNewer(channelId: string, message: AppMessage): void {
    const watermark = this.watermarks.get(channelId) ?? 0;
    if (message.seq <= watermark) return;
    this.watermarks.set(channelId, message.seq);
    const store = this.channelStates.get(channelId);
    if (!store) return;
    const state = store.get();
    const messages = [...state.messages, message].sort((a, b) => a.seq - b.seq);
    store.set({
      ...state,
      lastSeq: Math.max(state.lastSeq, message.seq),
      messages,
    });
  }

  private setChannelSynced(
    channelId: string,
    synced: boolean,
    lastSeq?: number,
  ): void {
    const store = this.channelStates.get(channelId);
    if (!store) return;
    const state = store.get();
    store.set({
      ...state,
      synced,
      lastSeq: Math.max(state.lastSeq, lastSeq ?? 0),
    });
  }

  private handleSocketClose(): void {
    // A close during the initial handshake already rejects connect() via
    // waitForOpen — don't start a reconnect loop on top of that rejection.
    const stillHandshaking = this.state.get() === "connecting";
    this.dropSocket(new RelayError("relay socket closed", "socket_closed"));
    if (stillHandshaking) {
      this.state.set("closed");
      return;
    }
    for (const channelId of this.subscribedChannels) {
      this.catchingUp.add(channelId);
      this.setChannelSynced(channelId, false);
    }
    if (this.manualClose || !this.options.autoReconnect) {
      this.connectPromise = undefined;
      this.state.set("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    this.state.set("reconnecting");
    const min = this.options.reconnectMinDelayMs;
    const max = this.options.reconnectMaxDelayMs;
    const delay = Math.min(max, min * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openAndHello()
        .then(() => {
          this.reconnectAttempt = 0;
          this.state.set("ready");
          return this.resync();
        })
        .catch((error: unknown) => {
          const relayError =
            error instanceof RelayError
              ? error
              : new RelayError("reconnect failed", "connect_failed");
          if (
            relayError.code === "protocol_version_mismatch" ||
            relayError.code === "unauthenticated"
          ) {
            // Fatal handshake failures are config, not transient: stop retrying.
            this.connectPromise = undefined;
            this.state.set("closed");
            this.options.onFatalError?.(relayError);
            return;
          }
          this.scheduleReconnect();
        });
    }, delay);
  }

  private dropSocket(error: RelayError): void {
    const socket = this.socket;
    this.socket = undefined;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (socket) {
      try {
        socket.close();
      } catch {
        // generation already invalidated
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
