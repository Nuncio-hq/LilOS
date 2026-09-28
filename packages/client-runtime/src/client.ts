import {
  APP_PROTOCOL_VERSION,
  type AppChannel,
  type AppMessage,
  ChannelCreatedEvent,
  ChannelRemovedEvent,
  ChannelSnapshotEvent,
  ChannelSyncedEvent,
  type Conversation,
  type ConversationSummary,
  ConversationUpdatedEvent,
  type Employee,
  type EmployeePatch,
  type EmployeesCreateParamsInput,
  EmployeeUpsertedEvent,
  JsonRpcNotification,
  JsonRpcResponse,
  MessageCreatedEvent,
  type ProfileSettings,
  ProfileUpdatedEvent,
  type RequestId,
  type RpcError,
  SystemStatusResult,
  type WelcomeResult,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  AgentsCreateParams,
  ModelsListResult,
} from "@lilos/contracts/engine";
import { atom, type WritableAtom } from "nanostores";
import {
  defaultSocketFactory,
  type RelaySocket,
  SOCKET_OPEN,
  type SocketFactory,
} from "./socket";
import type { StatusPollState } from "./status";

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
  /**
   * Every incoming JSON-RPC notification, before the built-in handling — the
   * harness-level events (ask.opened/ask.resolved, turn.interruptRequested,
   * channel.created) have no atom yet and are consumed through this hook.
   * Equivalent to calling `onEvent(fn)` after construction.
   */
  onEvent?: (method: string, params: Record<string, unknown>) => void;
  /**
   * Answers requests the relay sends TO this client — the engine
   * passthrough (`agents.*`/`models.*`) is forwarded this way to the
   * harness, which sets the handler that dispatches into the engine.
   * A thrown error's numeric `code`/`data` ride back to the caller.
   */
  onRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
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
  /** Relay-owned profile (#118) — `{}` on an untouched install; the app
      layers OS-derived prefill on top (AC-4). */
  readonly profile: WritableAtom<ProfileSettings> = atom({});
  /**
   * Per-conversation list rows (title, root, answer preview, state) that
   * survive the channel snapshot window — refreshed on connect and patched
   * by conversation/message notifications (#28).
   */
  readonly conversationSummaries: WritableAtom<ConversationSummary[]> = atom(
    [],
  );
  /** Latest system.status poll + the transport state it was taken under. */
  readonly status: WritableAtom<StatusPollState> = atom<StatusPollState>({
    connection: "idle",
  });
  /** Fatal handshake failure (version mismatch, bad token) once raised. */
  readonly fatal: WritableAtom<RelayError | undefined> = atom(undefined);

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
  private requestHandler:
    | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  private nextRequestId = 1;
  private readonly eventListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
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
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    this.state.listen((connection) => {
      this.status.set({ ...this.status.get(), connection });
    });
    if (options.onRequest) {
      this.requestHandler = async (m, p) => await options.onRequest?.(m, p);
    }
  }

  /**
   * Set/replace the handler answering relay → client requests. The harness
   * installs one that forwards `agents.*`/`models.*` into the engine.
   */
  setRequestHandler(
    fn:
      | ((
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown> | unknown)
      | undefined,
  ): void {
    this.requestHandler = fn ? async (m, p) => await fn(m, p) : undefined;
  }

  /**
   * Subscribe to raw protocol notifications (pre-dispatch). Returns an
   * unsubscribe function. Used by the harness for ask/interrupt/channel
   * lifecycle events that have no atom.
   */
  onEvent(
    fn: (method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
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
        if (
          error instanceof RelayError &&
          (error.code === "protocol_version_mismatch" ||
            error.code === "unauthenticated")
        ) {
          this.fatal.set(error);
        }
        throw error;
      });
    return this.connectPromise;
  }

  /**
   * The one aggregate health call (issue #33). `logLines > 0` asks the relay
   * to include redacted log tails — that's the diagnostics bundle payload.
   */
  async systemStatus(params?: {
    logLines?: number;
  }): Promise<SystemStatusResult> {
    return SystemStatusResult.parse(
      await this.request("system.status", { logLines: params?.logLines ?? 0 }),
    );
  }

  /** Poll `system.status` once and publish it to the `status` atom. */
  async refreshSystemStatus(logLines = 0): Promise<void> {
    try {
      const result = await this.systemStatus({ logLines });
      this.status.set({
        connection: this.state.get(),
        result,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      this.status.set({
        connection: this.state.get(),
        error: e instanceof Error ? e.message : "status poll failed",
      });
    }
  }

  /**
   * Refresh on connect/reconnect and on `intervalMs`; returns a stopper.
   * Failures land on the atom as `error` — the rows fall back to the
   * synthesized transport states instead of going blank.
   */
  startStatusPolling(intervalMs = 15_000, logLines = 0): () => void {
    void this.refreshSystemStatus(logLines);
    const unsub = this.state.listen((state) => {
      if (state === "ready") void this.refreshSystemStatus(logLines);
    });
    const timer = setInterval(() => {
      if (this.state.get() === "ready") void this.refreshSystemStatus(logLines);
      else this.status.set({ connection: this.state.get() });
    }, intervalMs);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }

  close(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.dropSocket(new RelayError("relay client closed", "closed"));
    this.connectPromise = undefined;
    this.state.set("closed");
  }

  /* ------------------- employee + engine convenience calls ------------------- */

  async createEmployee(input: EmployeesCreateParamsInput): Promise<Employee> {
    const { employee } = await this.request<{ employee: Employee }>(
      "employees.create",
      input as Record<string, unknown>,
    );
    const list = this.employees.get();
    if (!list.some((e) => e.id === employee.id)) {
      this.employees.set([...list, employee]);
    }
    return employee;
  }

  async updateEmployee(id: string, patch: EmployeePatch): Promise<Employee> {
    const { employee } = await this.request<{ employee: Employee }>(
      "employees.update",
      { id, ...patch } as Record<string, unknown>,
    );
    this.employees.set(
      this.employees.get().map((e) => (e.id === id ? employee : e)),
    );
    return employee;
  }

  /**
   * Remove deletes only the LilOS record; the engine profile is untouched
   * (engines own profiles — there is no profile-delete call anywhere).
   */
  async removeEmployee(id: string): Promise<void> {
    await this.request("employees.remove", { id });
    this.employees.set(this.employees.get().filter((e) => e.id !== id));
  }

  /**
   * Merge profile settings (#118). The result is the stored profile; the
   * `profile.updated` broadcast lands the same value on every open window.
   */
  async updateProfile(patch: ProfileSettings): Promise<ProfileSettings> {
    const { profile } = await this.request<{ profile: ProfileSettings }>(
      "profile.update",
      patch as Record<string, unknown>,
    );
    this.profile.set(profile);
    return profile;
  }

  /** Engine roster + model catalog, forwarded through the relay to the host. */
  async listAgents(): Promise<AgentDescriptor[]> {
    const { agents } = await this.request<{ agents: AgentDescriptor[] }>(
      "agents.list",
      {},
    );
    return agents;
  }

  async describeAgent(id: string): Promise<AgentDescriptor> {
    const { agent } = await this.request<{ agent: AgentDescriptor }>(
      "agents.describe",
      { id },
    );
    return agent;
  }

  async createAgent(params: AgentsCreateParams): Promise<AgentDescriptor> {
    const { agent } = await this.request<{ agent: AgentDescriptor }>(
      "agents.create",
      params as Record<string, unknown>,
    );
    return agent;
  }

  async listModels(params?: { refresh?: boolean }): Promise<ModelsListResult> {
    return await this.request<ModelsListResult>("models.list", params ?? {});
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
      const [employees, channels, conversations, summaries, settings] =
        await Promise.all([
          this.request<{ employees: Employee[] }>("employees.list", {}),
          this.request<{ channels: AppChannel[] }>("channels.list", {}),
          // Archived included: the DM list renders its own Archived section.
          this.request<{ conversations: Conversation[] }>(
            "conversations.list",
            { includeArchived: true },
          ),
          this.request<{ summaries: ConversationSummary[] }>(
            "conversations.summaries",
            { includeArchived: true },
          ),
          this.request<{ profile: ProfileSettings }>("profile.get", {}),
        ]);
      this.employees.set(employees.employees);
      this.channels.set(channels.channels);
      this.conversations.set(conversations.conversations);
      this.conversationSummaries.set(summaries.summaries);
      this.profile.set(settings.profile);
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
      // method + id = a request the relay asks this client to answer
      // (engine passthrough); method alone = a notification.
      if (raw.id !== undefined) {
        void this.handleRequest(
          raw.id as RequestId,
          raw.method,
          (raw.params ?? {}) as Record<string, unknown>,
        );
        return;
      }
      const asNotification = JsonRpcNotification.safeParse(parsed);
      if (asNotification.success) {
        this.handleNotification(
          asNotification.data.method,
          asNotification.data.params ?? {},
        );
      }
    }
  }

  private async handleRequest(
    id: RequestId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    const handler = this.requestHandler;
    if (!handler) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `no handler for ${method}` },
        }),
      );
      return;
    }
    try {
      const result = await handler(method, params);
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }),
      );
    } catch (error) {
      const e = error as { code?: unknown; data?: unknown };
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: typeof e.code === "number" ? e.code : -32603,
            message: error instanceof Error ? error.message : "request failed",
            ...(e.data !== undefined ? { data: e.data } : {}),
          },
        }),
      );
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
    for (const fn of this.eventListeners) {
      try {
        fn(method, params);
      } catch {
        // A consumer hook must never break the client's own dispatch.
      }
    }
    switch (method) {
      case "channel.created": {
        const event = ChannelCreatedEvent.parse(params);
        const list = this.channels.get();
        if (!list.some((c) => c.id === event.channel.id)) {
          this.channels.set([...list, event.channel]);
        }
        return;
      }
      case "channel.removed": {
        const event = ChannelRemovedEvent.parse(params);
        this.dropChannel(event.channelId);
        return;
      }
      case "host.changed": {
        // The engine host registered or disconnected — refresh status now
        // instead of waiting for the next poll tick (#148).
        void this.refreshSystemStatus();
        return;
      }
      case "profile.updated": {
        this.profile.set(ProfileUpdatedEvent.parse(params).profile);
        return;
      }
      case "employee.upserted": {
        const event = EmployeeUpsertedEvent.parse(params);
        const list = this.employees.get();
        const idx = list.findIndex((e) => e.id === event.employee.id);
        this.employees.set(
          idx === -1
            ? [...list, event.employee]
            : list.map((e) =>
                e.id === event.employee.id ? event.employee : e,
              ),
        );
        return;
      }
      case "employee.removed": {
        const { employeeId } = params as { employeeId?: string };
        if (typeof employeeId === "string") {
          this.employees.set(
            this.employees.get().filter((e) => e.id !== employeeId),
          );
        }
        return;
      }
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
        this.patchSummaryForMessage(event.message);
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
        const summaries = this.conversationSummaries.get();
        const sIdx = summaries.findIndex(
          (s) => s.conversation.id === event.conversation.id,
        );
        if (sIdx === -1) {
          // A conversation this client has never summarized — refresh so the
          // DM list gains the row (root + preview) without waiting for a
          // restart.
          void this.refreshSummaries();
        } else {
          this.conversationSummaries.set(
            summaries.map((s) =>
              s.conversation.id === event.conversation.id
                ? { ...s, conversation: event.conversation }
                : s,
            ),
          );
        }
        return;
      }
    }
  }

  /** Keep one summary row current as its conversation accrues messages. */
  private patchSummaryForMessage(message: AppMessage): void {
    const convId = message.conversationId;
    if (!convId) return;
    const summaries = this.conversationSummaries.get();
    const idx = summaries.findIndex((s) => s.conversation.id === convId);
    if (idx === -1) {
      void this.refreshSummaries();
      return;
    }
    const isAnswer = message.authorKind !== "user";
    this.conversationSummaries.set(
      summaries.map((s) =>
        s.conversation.id === convId
          ? {
              ...s,
              last: message,
              messageCount: s.messageCount + 1,
              firstAnswer: s.firstAnswer ?? (isAnswer ? message : undefined),
            }
          : s,
      ),
    );
  }

  private async refreshSummaries(): Promise<void> {
    try {
      const res = await this.request<{ summaries: ConversationSummary[] }>(
        "conversations.summaries",
        { includeArchived: true },
      );
      this.conversationSummaries.set(res.summaries);
    } catch {
      /* best-effort — the full refresh runs on the next (re)connect */
    }
  }

  /** Drop a deleted channel: atom, per-channel message state, replay state. */
  private dropChannel(channelId: string): void {
    this.channels.set(this.channels.get().filter((c) => c.id !== channelId));
    this.conversations.set(
      this.conversations.get().filter((c) => c.channelId !== channelId),
    );
    this.conversationSummaries.set(
      this.conversationSummaries
        .get()
        .filter((s) => s.conversation.channelId !== channelId),
    );
    this.subscribedChannels.delete(channelId);
    this.catchingUp.delete(channelId);
    this.watermarks.delete(channelId);
    this.parked.delete(channelId);
    this.channelStates.get(channelId)?.set({
      channelId,
      synced: false,
      lastSeq: 0,
      messages: [],
    });
    this.channelStates.delete(channelId);
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
            this.fatal.set(relayError);
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
