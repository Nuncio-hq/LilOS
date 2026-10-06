import {
  APP_PROTOCOL_VERSION,
  type AppChannel,
  type AppMessage,
  type Ask,
  AskOpenedEvent,
  AskResolvedEvent,
  ChannelCreatedEvent,
  ChannelRemovedEvent,
  ChannelSnapshotEvent,
  ChannelSyncedEvent,
  ConnectChangedEvent,
  type Conversation,
  ConversationRewoundEvent,
  type ConversationSummary,
  ConversationUpdatedEvent,
  DevicesChangedEvent,
  type Employee,
  type EmployeePatch,
  type EmployeesCreateParamsInput,
  EmployeeUpsertedEvent,
  EngineEventEvent,
  JsonRpcNotification,
  JsonRpcResponse,
  MessageChangedEvent,
  MessageCreatedEvent,
  type PairedDevice,
  type PairingOffer,
  type ProfileSettings,
  ProfileUpdatedEvent,
  type RequestId,
  type RpcError,
  SystemStatusResult,
  type WelcomeResult,
  WS_CLOSE_DEVICE_REVOKED,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  AgentsCreateParams,
  AgentsUpdateParams,
  AgentsUpdateResult,
  EngineEvent,
  EventsSinceResult,
  ModelsListResult,
  OpenRequest,
  SessionSnapshot,
} from "@lilos/contracts/engine";
import { atom, type WritableAtom } from "nanostores";
import {
  type CachedDirectory,
  DEVICE_CACHE_SCHEMA_VERSION,
} from "./device-cache";
import { mergeFeedEvents } from "./feed-merge";
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

/**
 * #625: the relay gates the `/ws` upgrade on a credential before the socket
 * exists, and a browser WebSocket can't set headers — so the same credential
 * `session.hello` will present rides the URL's query (the #564 feed-gate
 * pattern): `?token=` for the install token, `?deviceId=&credential=` for a
 * paired phone. Computed per-connect so a reconnect carries it too.
 */
const relaySocketUrl = (
  url: string,
  opts: {
    token?: string;
    device?: { deviceId: string; credential: string };
  },
): string => {
  const sep = url.includes("?") ? "&" : "?";
  if (opts.device) {
    return (
      `${url}${sep}deviceId=${encodeURIComponent(opts.device.deviceId)}` +
      `&credential=${encodeURIComponent(opts.device.credential)}`
    );
  }
  if (opts.token) {
    return `${url}${sep}token=${encodeURIComponent(opts.token)}`;
  }
  return url;
};

export interface ChannelMessagesState {
  channelId: string;
  /** True once the replay/snapshot window closed (`channel.synced`). */
  synced: boolean;
  /** Highest message seq applied. */
  lastSeq: number;
  /** Seq-ordered visible messages. */
  messages: AppMessage[];
}

/**
 * One conversation's engine-event feed (#157) — the phone-facing mirror of
 * `EngineClient.sessionFeed`: live `engine.event` channel frames + replay
 * via `session.events`, merged on `sessionId|seq`, resynced on reconnect.
 * Keyed by conversationId (the id a device-scope client has); the engine
 * sessionId lands once the first frame or replay answers.
 */
export interface RelaySessionFeedState {
  conversationId: string;
  /** Engine session the conversation is bound to, once known. */
  sessionId?: string;
  /** True once the first `session.events` replay answered. */
  synced: boolean;
  /** Engine's reported seq horizon at last sync. */
  latestSeq: number;
  /** Watermark the caller replays from — highest seq applied. Seq restarts
     at 1 per engine session, so this always tracks the *current* sessionId's
     seq space and rebases when the bound session changes. */
  coverageSeq: number;
  /** Every event applied so far, arrival order (seq order per session). */
  events: EngineEvent[];
  /** Asks awaiting `request.respond`. */
  openRequests: OpenRequest[];
  /** The engine's session snapshot (state/model/turn), when synced. */
  snapshot?: SessionSnapshot;
  /** #431: the host's log is capped — the transcript's retained head is
     all that exists (session.events answered `truncated`). */
  historyTrimmed?: boolean;
  error?: string;
}

export interface RelayClientOptions {
  /** ws:// or wss:// relay endpoint (path included, e.g. ws://127.0.0.1:4577/ws). */
  url: string;
  /**
   * Per-install token (relay writes it to <home>/relay-token on first run).
   * Required unless `device` authenticates the session instead.
   */
  token?: string;
  /**
   * Paired-device auth (#153): what `POST /pair/exchange` minted — the
   * phone's own credential, revocable per device without rotating the
   * install token. Wins over `token` when both are set.
   */
  device?: { deviceId: string; credential: string };
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
  /** True once the first directory refresh has landed — until then the list
      atoms above are empty snapshots, not "no rows" (#193). */
  readonly directoryReady: WritableAtom<boolean> = atom(false);
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
  /**
   * #134: latest rewind per conversation (conversationId -> first rewound
   * seq + the dropped message ids). Views holding fetched history outside
   * the channel atoms re-render off this so the dropped tail disappears in
   * every open window; `removedIds` lets the engine feed drop turns whose
   * `ref` points at a rewound user message (files-only rewind keeps them).
   */
  readonly rewinds: WritableAtom<
    Record<string, { fromSeq: number; removedIds: string[] }>
  > = atom({});
  /** Phones paired to this install (#153) — live via `devices.changed`. */
  readonly devices: WritableAtom<PairedDevice[]> = atom([]);
  /**
   * Everything the relay reports via `asks.list` (open and resolved, sorted
   * `createdAt` asc — the same order the store serves). Live deltas arrive
   * as `ask.opened`/`ask.resolved` notifications on the channel's
   * subscription and upsert by id (#155). Volatile, so never cached on
   * device — a stale "1 needs you" is worse than a beat of none.
   */
  readonly asks: WritableAtom<Ask[]> = atom([]);
  /**
   * Why the socket last dropped. Close-code aware: `devices.revoke` ends the
   * socket 4403 → `code: "device_revoked"` — a dead credential the app must
   * re-pair for, not a transient transport loss (#154).
   */
  lastSocketError: RelayError | undefined;

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
  /* `message.changed` frames held during a catchup: applied live they'd be
     stomped by the in-flight `channel.snapshot`, which carries subscribe-
     time rows (#315 — a Send right after reload lost its `dropped` flip). */
  private readonly parkedChanged = new Map<string, AppMessage[]>();
  private readonly channelStates = new Map<
    string,
    WritableAtom<ChannelMessagesState>
  >();
  private readonly subscribedChannels = new Set<string>();
  private readonly sessionFeeds = new Map<
    string,
    WritableAtom<RelaySessionFeedState>
  >();
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

  /**
   * `agents.update` — edit a profile's persona/model (#123). The engine may
   * answer `confirmModel` instead of applying a guarded model: the caller
   * asks the user and re-sends with `confirmModel: true`.
   */
  async updateAgent(params: AgentsUpdateParams): Promise<AgentsUpdateResult> {
    return await this.request<AgentsUpdateResult>(
      "agents.update",
      params as Record<string, unknown>,
    );
  }

  async listModels(params?: { refresh?: boolean }): Promise<ModelsListResult> {
    return await this.request<ModelsListResult>("models.list", params ?? {});
  }

  /* --------------------- phone pairing (#153) ----------------------- */

  /**
   * "Turn on phone access": binds the Tailscale listener and mints a fresh
   * one-time grant for the Pair phone dialog to render. Rejects with
   * `tailscale_unavailable` when the tailnet is down — the dialog shows its
   * no-remote state then.
   */
  async pairingOffer(): Promise<PairingOffer> {
    const { offer } = await this.request<{ offer: PairingOffer }>(
      "pairing.offer",
      {},
    );
    return offer;
  }

  /** Turn phone access back off: unbinds the Tailscale listener. */
  async pairingDisable(): Promise<void> {
    await this.request("pairing.disable", {});
  }

  async listDevices(): Promise<PairedDevice[]> {
    const { devices } = await this.request<{ devices: PairedDevice[] }>(
      "devices.list",
      {},
    );
    this.devices.set(devices);
    return devices;
  }

  /** Revoke a paired device — the relay closes its live socket too. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.request("devices.revoke", { deviceId });
  }

  /**
   * Keep-vs-replace probe (#154): the connection supervisor pings the live
   * socket on foreground — a timeout or error means the transport is dead
   * and the socket gets replaced, an answer means keep it.
   */
  async ping(timeoutMs = 3_000): Promise<void> {
    await this.request("session.ping", {}, timeoutMs);
  }

  async request<T>(
    method: string,
    params?: Record<string, unknown>,
    /** Per-call timeout override — the foreground probe uses ~3s (#154). */
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new RelayError("relay not connected", "not_connected");
    }
    const id = `r${this.nextRequestId++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError(`request ${method} timed out`, "timeout"));
      }, timeoutMs);
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

  /* ----------------- device cache hydrate/snapshot (#154) ----------------- */

  /**
   * Cold-start hydrate: seed the directory atoms and seq watermarks from the
   * on-device cache so Home renders before the socket opens, then reconnect
   * replays only what changed (`afterSeq` on the seeded watermarks).
   */
  hydrate(snapshot: CachedDirectory): void {
    this.employees.set(snapshot.employees);
    this.channels.set(snapshot.channels);
    this.conversations.set(snapshot.conversations);
    this.conversationSummaries.set(snapshot.conversationSummaries);
    this.profile.set(snapshot.profile);
    /* #591: last-known asks too — Activity shows them marked, offline. */
    this.asks.set(snapshot.asks);
    this.watermarks.clear();
    for (const [channelId, seq] of Object.entries(snapshot.watermarks)) {
      this.watermarks.set(channelId, seq);
    }
  }

  /** Current directory state + watermarks — what the device cache persists. */
  snapshot(): CachedDirectory {
    return {
      schemaVersion: DEVICE_CACHE_SCHEMA_VERSION,
      savedAt: Date.now(),
      employees: this.employees.get(),
      channels: this.channels.get(),
      conversations: this.conversations.get(),
      conversationSummaries: this.conversationSummaries.get(),
      profile: this.profile.get(),
      asks: this.asks.get(),
      watermarks: Object.fromEntries(this.watermarks),
    };
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
    this.parkedChanged.delete(channelId);
    if (this.state.get() === "ready") {
      await this.request("channel.unsubscribe", { channelId });
    }
  }

  /**
   * A conversation's engine-event feed (#157): live `engine.event` frames on
   * the channel subscription + `session.events` replay merged on
   * `sessionId|seq`. Creating a feed kicks off a replay; live frames and
   * reconnects merge onto it (no second round trip needed to see history).
   */
  sessionFeed(conversationId: string): WritableAtom<RelaySessionFeedState> {
    let store = this.sessionFeeds.get(conversationId);
    if (!store) {
      store = atom<RelaySessionFeedState>({
        conversationId,
        synced: false,
        latestSeq: 0,
        coverageSeq: 0,
        events: [],
        openRequests: [],
      });
      this.sessionFeeds.set(conversationId, store);
      if (this.state.get() === "ready") {
        void this.syncSessionFeed(conversationId).catch(() => {});
      }
    }
    return store;
  }

  /* ------------------------------ internals ----------------------------- */

  private async openAndHello(): Promise<WelcomeResult> {
    this.state.set(this.everConnected ? "reconnecting" : "connecting");
    this.lastSocketError = undefined;
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(
      relaySocketUrl(this.options.url, this.options),
    );
    this.socket = socket;
    this.attachSocketListeners(socket);
    try {
      await this.waitForOpen(socket);
    } catch (error) {
      /* #625: the relay refuses bad credentials at the upgrade — a refused
         handshake reaches the WebSocket API as a bare error/close with no
         HTTP status, indistinguishable from "relay down". If the relay's
         HTTP surface still answers, the refusal was our credential:
         surface `unauthenticated` so the fatal path (re-pair, fix the
         token) runs instead of an endless reconnect loop. A socket that
         opened never reaches this catch — a mid-handshake 4408 stays a
         retryable drop. */
      if (
        error instanceof RelayError &&
        error.code === "connect_failed" &&
        (await this.relayHttpUp())
      ) {
        throw new RelayError("relay refused the credential", "unauthenticated");
      }
      throw error;
    }
    try {
      const auth = this.options.device
        ? {
            deviceId: this.options.device.deviceId,
            credential: this.options.device.credential,
          }
        : { token: this.options.token ?? "" };
      const welcome = await this.request<WelcomeResult>("session.hello", {
        protocolVersion: this.options.protocolVersion,
        ...auth,
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

  /**
   * #625: does the relay's HTTP surface answer? ws/wss → http/https, `/ws`
   * → `/healthz`. True means a refused upgrade was the credential gate;
   * false means the relay is down and the failure stays transient.
   */
  private async relayHttpUp(): Promise<boolean> {
    const http = this.options.url
      .replace(/^ws(s?):/, "http$1:")
      .replace(/^(https?:\/\/[^/?#]+).*$/, "$1/healthz");
    /* AbortController/fetch exist in every runtime we ship, but a hung
       probe must never stall the failure path — race a bare timer too. */
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), 3_000);
    try {
      return await Promise.race([
        fetch(http, controller ? { signal: controller.signal } : {})
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 3_000),
        ),
      ]);
    } finally {
      clearTimeout(timer);
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
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.handleSocketClose(event);
    });
    socket.addEventListener("error", () => {
      // 'close' follows; nothing to do here.
    });
  }

  private async resync(): Promise<void> {
    // Directory refresh runs every (re)connect: employees/channels/
    // conversations are read-model lists, not seq-replayed.
    await Promise.all([
      this.refreshDirectory(),
      this.resubscribeAll(),
      this.resyncSessionFeeds(),
    ]);
  }

  /**
   * Re-replay every open feed from its watermark after (re)connect — live
   * `engine.event` frames can land mid-replay, so the merge dedupes by
   * `sessionId|seq` rather than assuming disjoint sets.
   */
  private async resyncSessionFeeds(): Promise<void> {
    await Promise.all(
      [...this.sessionFeeds.keys()].map((conversationId) =>
        this.syncSessionFeed(conversationId).catch(() => {}),
      ),
    );
  }

  /* One gap refetch per conversation at a time — a stalled run of live
     frames queues no pile of overlapping session.events calls; whichever
     lands last covers the newest hole. */
  private readonly feedSyncInFlight = new Set<string>();

  private syncSessionFeedOnce(conversationId: string): void {
    if (this.feedSyncInFlight.has(conversationId)) return;
    this.feedSyncInFlight.add(conversationId);
    void this.syncSessionFeed(conversationId)
      .catch(() => {})
      .finally(() => this.feedSyncInFlight.delete(conversationId));
  }

  private async syncSessionFeed(conversationId: string): Promise<void> {
    const store = this.sessionFeeds.get(conversationId);
    if (!store) return;
    const f = store.get();
    let res: EventsSinceResult;
    try {
      res = await this.request<EventsSinceResult>("session.events", {
        conversationId,
        after: f.coverageSeq,
      });
      /* coverageSeq is f.sessionId's seq space; if the host rebound the
         conversation to a different session while we were away, that `after`
         silently skipped the new log's head. Re-pull from zero once — the
         merge dedupes, so this is one extra round trip only on rebind. */
      if (f.sessionId && f.sessionId !== res.snapshot.sessionId) {
        res = await this.request<EventsSinceResult>("session.events", {
          conversationId,
          after: 0,
        });
      } else if (res.truncated && f.coverageSeq > 0) {
        /* #431: the watermark sits in a cap-dropped hole — the range can't
           be patched. Refetch the retained log from 0, same as the rebind
           refetch above. */
        res = await this.request<EventsSinceResult>("session.events", {
          conversationId,
          after: 0,
        });
      }
    } catch (error) {
      // `not_found` = no engine session bound yet — an honestly empty feed,
      // not a sync failure: mark synced so the screen stops waiting.
      if (error instanceof RelayError && error.code === "not_found") {
        store.set({ ...f, synced: true });
        return;
      }
      store.set({
        ...f,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const cur = store.get();
    /* A session (re)bind restarts seq at 1 — mergeFeedEvents keys the
       dedupe on sessionId too, so a fresh session's log can't be dropped
       against the old one's, and live frames landing mid-replay keep
       their copy. */
    const merged = mergeFeedEvents(cur.events, res.events);
    store.set({
      ...cur,
      sessionId: res.snapshot.sessionId,
      synced: true,
      latestSeq: res.latestSeq,
      coverageSeq:
        res.snapshot.sessionId === cur.sessionId
          ? Math.max(res.latestSeq, cur.coverageSeq)
          : res.latestSeq,
      events: merged,
      openRequests: res.openRequests,
      /* #327: stamp the point the snapshot was captured at — live
         `engine.event` frames keep landing on `events` without
         refreshing it, so the fold (turn-model) reads `atSeq` to tell
         a current snapshot from a stale one. */
      snapshot: { ...res.snapshot, atSeq: res.latestSeq } as SessionSnapshot,
      error: undefined,
      /* Sticky — see SessionFeedState.historyTrimmed in engine.ts. */
      historyTrimmed: cur.historyTrimmed || res.truncated,
    });
  }

  private async refreshDirectory(): Promise<void> {
    /* `devices.list` is pairing admin: the relay refuses it for a paired
       phone (device scope). It must not sink the rest of the directory —
       one rejected read inside the Promise.all below used to leave a phone
       with an empty Home. Only token-scope clients (the Mac) ask for it. */
    const devicesRead = this.options.device
      ? Promise.resolve(undefined)
      : this.request<{ devices: PairedDevice[] }>("devices.list", {}).catch(
          () => undefined,
        );
    try {
      const [
        employees,
        channels,
        conversations,
        summaries,
        settings,
        devices,
        asks,
      ] = await Promise.all([
        this.request<{ employees: Employee[] }>("employees.list", {}),
        this.request<{ channels: AppChannel[] }>("channels.list", {}),
        // Archived included: the DM list renders its own Archived section.
        this.request<{ conversations: Conversation[] }>("conversations.list", {
          includeArchived: true,
        }),
        this.request<{ summaries: ConversationSummary[] }>(
          "conversations.summaries",
          { includeArchived: true },
        ),
        this.request<{ profile: ProfileSettings }>("profile.get", {}),
        devicesRead,
        this.request<{ asks: Ask[] }>("asks.list", {}),
      ]);
      this.employees.set(employees.employees);
      this.channels.set(channels.channels);
      this.conversations.set(conversations.conversations);
      this.conversationSummaries.set(summaries.summaries);
      this.profile.set(settings.profile);
      if (devices) this.devices.set(devices.devices);
      this.asks.set(asks.asks);
      this.directoryReady.set(true);
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
      this.parkedChanged.delete(channelId);
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
      case "connect.changed": {
        /* #413: the Connect rows live on `system.status` — patch the atom in
           place so the DM notice and Settings → Engine update now instead of
           on the next poll. `connect` absent clears the rows; the next
           poll's result replaces the patch wholesale. Nothing to patch
           before the first fetch — that poll already carries the rows. */
        const event = ConnectChangedEvent.parse(params);
        const current = this.status.get();
        if (current.result) {
          this.status.set({
            ...current,
            result: { ...current.result, connect: event.connect },
          });
        }
        return;
      }
      case "profile.updated": {
        this.profile.set(ProfileUpdatedEvent.parse(params).profile);
        return;
      }
      case "devices.changed": {
        this.devices.set(DevicesChangedEvent.parse(params).devices);
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
      case "message.changed": {
        /* #315: dropped/removed flipped — same seq, so dispatchIfNewer can't
           carry it; replace the stored row in place. */
        const event = MessageChangedEvent.parse(params);
        if (this.catchingUp.has(event.channelId)) {
          /* Park like message.created: the in-flight snapshot's subscribe-
             time rows would stomp the flag flip if it applied now. */
          const list = this.parkedChanged.get(event.channelId) ?? [];
          list.push(event.message);
          this.parkedChanged.set(event.channelId, list);
          return;
        }
        this.applyMessageChanged(event.channelId, event.message);
        const summaries = this.conversationSummaries.get();
        if (
          event.message.conversationId &&
          summaries.some(
            (s) =>
              s.conversation.id === event.message.conversationId &&
              s.last?.id === event.message.id,
          )
        ) {
          this.conversationSummaries.set(
            summaries.map((s) =>
              s.last?.id === event.message.id
                ? { ...s, last: event.message }
                : s,
            ),
          );
        }
        return;
      }
      case "channel.snapshot": {
        const event = ChannelSnapshotEvent.parse(params);
        const store = this.channelStates.get(event.channelId);
        this.watermarks.set(event.channelId, event.lastSeq);
        /* #377: the read layer omits `dropped`/`removed`/`rewound` rows, so
           a wholesale snapshot replace would erase local tombstones — the
           fetch-time `threadMsgs` copy then resurrects a dead send as a
           live bubble (a relay restart resyncs via snapshot, not replay).
           Carry tombstones the snapshot can't carry. */
        const tombstones = (store?.get().messages ?? []).filter(
          (m) =>
            (m.dropped || m.removed || m.rewound) &&
            !event.messages.some((n) => n.id === m.id),
        );
        store?.set({
          channelId: event.channelId,
          synced: false,
          lastSeq: event.lastSeq,
          messages: [...event.messages, ...tombstones].sort(
            (a, b) => a.seq - b.seq,
          ),
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
        const parkedFlips = this.parkedChanged.get(event.channelId) ?? [];
        this.parkedChanged.delete(event.channelId);
        for (const message of parkedFlips) {
          this.applyMessageChanged(event.channelId, message);
        }
        const wm = this.watermarks.get(event.channelId) ?? 0;
        if (event.lastSeq > wm)
          this.watermarks.set(event.channelId, event.lastSeq);
        this.setChannelSynced(event.channelId, true, event.lastSeq);
        /* conversation.updated rides this subscription only: a conversation
           that went active between the directory refresh and the subscribe
           (e.g. a brand-new DM's first turn) would stay stale in the atom.
           Re-pull the channel's conversations once the replay window closes. */
        void this.refreshChannelConversations(event.channelId).catch(() => {});
        return;
      }
      case "conversation.rewound": {
        const event = ConversationRewoundEvent.parse(params);
        const store = this.channelStates.get(event.channelId);
        if (store) {
          const state = store.get();
          store.set({
            ...state,
            messages: state.messages.filter(
              (m) =>
                m.conversationId !== event.conversationId ||
                m.seq < event.fromSeq,
            ),
          });
        }
        const parked = this.parked.get(event.channelId);
        if (parked) {
          this.parked.set(
            event.channelId,
            parked.filter(
              (m) =>
                m.conversationId !== event.conversationId ||
                m.seq < event.fromSeq,
            ),
          );
        }
        const prevRewind = this.rewinds.get()[event.conversationId];
        this.rewinds.set({
          ...this.rewinds.get(),
          [event.conversationId]: {
            fromSeq: event.fromSeq,
            removedIds: [
              ...(prevRewind?.removedIds ?? []),
              ...event.removedIds,
            ],
          },
        });
        void this.refreshSummaries();
        return;
      }
      case "engine.event": {
        /* A host re-published one engine event of a bound session (#157):
           append it to that conversation's feed. Dedupes against replayed
           events by `sessionId|seq`; a new sessionId means a (re)bound
           session whose log restarts — the old tail is kept (the reducer
           picks only the live session anyway). */
        const event = EngineEventEvent.parse(params);
        const store = this.sessionFeeds.get(event.conversationId);
        if (!store) return;
        const f = store.get();
        const sid = event.event.sessionId;
        /* Live frames arrive ordered per session, so only a seq at/under the
           watermark can be a duplicate worth the O(n) scan — the common
           append path just checks the watermark. A rebound session restarts
           seq at 1: coverage tracks the current session's space, not a
           global max that would skip the new log's head on the next replay. */
        const dup =
          sid === f.sessionId && event.event.seq > f.coverageSeq
            ? false
            : f.events.some(
                (e) => e.sessionId === sid && e.seq === event.event.seq,
              );
        if (dup) return;
        /* Coverage is contiguous, not a high-water mark: a frame arriving
           after a broadcast gap must NOT lift the watermark past the hole,
           or the next replay's `after` skips the lost seq forever (#400 —
           an ask or completion emitted while this socket was connected but
           not yet a feed peer stayed missing until the next reconnect). */
        const sameSession = event.sessionId === f.sessionId;
        const nextCoverage = sameSession
          ? event.event.seq === f.coverageSeq + 1
            ? event.event.seq
            : f.coverageSeq
          : event.event.seq === 1
            ? 1
            : 0;
        store.set({
          ...f,
          sessionId: event.sessionId,
          coverageSeq: nextCoverage,
          events: [...f.events, event.event],
        });
        /* A skipped seq — a gap inside the current log, or a rebound log
           whose head we never saw — means this socket missed a window
           while connected: refetch instead of stalling until reconnect. */
        if (
          (sameSession
            ? nextCoverage < event.event.seq
            : event.event.seq > 1) &&
          this.state.get() === "ready"
        )
          this.syncSessionFeedOnce(event.conversationId);
        return;
      }
      case "conversation.updated": {
        const event = ConversationUpdatedEvent.parse(params);
        /* A conversation gained an engine session (engineRef bound): an
           empty/unsynced feed resyncs now so history shows without a
           reopen. */
        const feed = this.sessionFeeds.get(event.conversation.id);
        if (
          event.conversation.engineRef &&
          feed &&
          (!feed.get().synced || feed.get().events.length === 0) &&
          this.state.get() === "ready"
        ) {
          void this.syncSessionFeed(event.conversation.id).catch(() => {});
        }
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
      case "ask.opened": {
        this.upsertAsk(AskOpenedEvent.parse(params).ask);
        return;
      }
      case "ask.resolved": {
        this.upsertAsk(AskResolvedEvent.parse(params).ask);
        return;
      }
    }
  }

  /** Re-pull one channel's conversations after a subscribe's replay window. */
  private async refreshChannelConversations(channelId: string): Promise<void> {
    const { conversations } = await this.request<{
      conversations: Conversation[];
    }>("conversations.list", { channelId, includeArchived: true });
    const rest = this.conversations
      .get()
      .filter((c) => c.channelId !== channelId);
    this.conversations.set(
      [...rest, ...conversations].sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  /** Insert or replace an ask, keeping the atom's `createdAt` order. */
  private upsertAsk(ask: Ask): void {
    const list = this.asks.get().filter((a) => a.id !== ask.id);
    const idx = list.findIndex((a) => a.createdAt > ask.createdAt);
    if (idx === -1) list.push(ask);
    else list.splice(idx, 0, ask);
    this.asks.set(list);
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

  /* #315: a flag flip (`dropped`/`removed`) lands at the same seq, so it
     replaces the stored row in place — or inserts in seq order when the
     row isn't there (a changed event can beat the fetch that would have
     carried it). */
  private applyMessageChanged(channelId: string, message: AppMessage): void {
    const store = this.channelStates.get(channelId);
    const state = store?.get();
    if (!store || !state) return;
    store.set({
      ...state,
      messages: state.messages.some((m) => m.id === message.id)
        ? state.messages.map((m) => (m.id === message.id ? message : m))
        : [...state.messages, message].sort((a, b) => a.seq - b.seq),
    });
  }

  /** Drop a deleted channel: atom, per-channel message state, replay state. */
  private dropChannel(channelId: string): void {
    this.channels.set(this.channels.get().filter((c) => c.id !== channelId));
    this.asks.set(this.asks.get().filter((a) => a.channelId !== channelId));
    this.conversations.set(
      this.conversations.get().filter((c) => c.channelId !== channelId),
    );
    this.conversationSummaries.set(
      this.conversationSummaries
        .get()
        .filter((s) => s.conversation.channelId !== channelId),
    );
    /* Per-conversation state on this channel goes too — otherwise feeds
       and rewind records for deleted conversations live forever. */
    const convIds = new Set(
      this.conversations
        .get()
        .filter((c) => c.channelId === channelId)
        .map((c) => c.id),
    );
    for (const id of convIds) this.sessionFeeds.delete(id);
    const rewinds = { ...this.rewinds.get() };
    for (const id of convIds) delete rewinds[id];
    this.rewinds.set(rewinds);
    this.subscribedChannels.delete(channelId);
    this.catchingUp.delete(channelId);
    this.watermarks.delete(channelId);
    this.parked.delete(channelId);
    this.parkedChanged.delete(channelId);
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

  private handleSocketClose(event?: { code: number; reason: string }): void {
    // A close during the initial handshake already rejects connect() via
    // waitForOpen — don't start a reconnect loop on top of that rejection.
    const stillHandshaking = this.state.get() === "connecting";
    const revoked = event?.code === WS_CLOSE_DEVICE_REVOKED;
    this.dropSocket(
      revoked
        ? new RelayError(event.reason || "device revoked", "device_revoked", {
            closeCode: event.code,
          })
        : new RelayError("relay socket closed", "socket_closed", {
            closeCode: event?.code,
            closeReason: event?.reason,
          }),
    );
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
    this.lastSocketError = error;
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
