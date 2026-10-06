import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  APP_PROTOCOL_VERSION,
  type AppErrorCode,
  type AttachmentInput,
  ENGINE_PASSTHROUGH_METHODS,
  ENGINE_PASSTHROUGH_PARAMS,
  type EnginePassthroughMethod,
  type JsonRpcRequest,
  MAX_ATTACHMENT_BYTES,
  type MessageAttachment,
} from "@lilos/contracts/app";
import {
  type AttachmentStore,
  createMemoryAttachmentStore,
} from "./attachments";
import { createLogTail, type LogTail } from "./logtail";
import type { PairingService } from "./pairing";
import type { PushFanout } from "./push";
import { handleAsks } from "./session/asks";
import { handleChannel } from "./session/channel";
import { handleConversations } from "./session/conversations";
import type { RelayCtx, RelaySharedCtx } from "./session/ctx";
import { handleDirectory } from "./session/directory";
import { handleHandshake } from "./session/handshake";
import { handleHarness } from "./session/harness";
import { handleHostEvents } from "./session/host-events";
import { handleMessages } from "./session/messages";
import { handlePairing } from "./session/pairing";
import {
  badParams,
  type HostRecord,
  JsonRpcCode,
  RpcError,
} from "./session/rpc";
import { handleSettings } from "./session/settings";
import { handleTurns } from "./session/turns";
import type { RejectedHandshake } from "./status";
import type { RelayStore } from "./store";

/** Minimal ws peer surface — Bun's ServerWebSocket and test doubles fit this. */
export interface RelayWsPeer {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayOptions {
  store: RelayStore;
  /** Per-install token from auth.ts; checked in session.hello. */
  token: string;
  /** Where attachment bytes land; memory when absent (tests). */
  attachments?: AttachmentStore;
  protocolVersion?: number;
  relayVersion?: string;
  /** Replay cap on subscribe: a gap larger than this falls back to a snapshot. */
  maxReplay?: number;
  /** Snapshot window when the client has no usable cursor. */
  snapshotLimit?: number;
  /** system.status: a harness heartbeat older than this marks it degraded. */
  heartbeatFreshMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Log sink the relay lifecycle is written to; defaults to a fresh tail. */
  logTail?: LogTail;
  /** How long a forwarded engine call may go unanswered (default 15s). */
  hostCallTimeoutMs?: number;
  /**
   * Phone pairing service (#153): mints one-time grants, exchanges them for
   * per-device credentials, and authenticates `session.hello` device calls.
   * Absent = pairing methods are unavailable (tests, bare relays).
   */
  pairing?: PairingService;
  /**
   * The Tailscale-listener seam (#153): `enable()` binds the relay's ws+http
   * on the tailnet address and returns the host to advertise in the offer
   * (`name:port`); null means Tailscale is down → `tailscale_unavailable`.
   */
  phoneAccess?: PhoneAccess;
  /** Display name for the pairing offer ("Alice's Mac"). */
  macName?: string;
  /**
   * The home-folder boundary device peers may touch (#238): `folders.add`
   * from a paired phone is refused outside it, and the harness applies the
   * same boundary to `folders.browse`/`folders.discover`. Defaults to the
   * OS home dir (injectable for tests).
   */
  homeDir?: string;
  /**
   * Push fan-out (#161): turns `asks.open`/`engine.event` transitions into
   * Expo pushes for registered phones. Absent = the push methods still
   * serve (registration persists) but nothing is sent (tests, bare relays).
   */
  push?: PushFanout;
}

/** The opt-in Tailscale bind — implemented in index.ts over `Bun.serve`. */
export interface PhoneAccess {
  /** Idempotent: an already-bound tailnet listener returns its host. */
  enable(): Promise<{ host: string } | null>;
  disable(): Promise<void>;
}

interface RelayConnection {
  receive(data: string): Promise<void>;
  closed(): void;
}

export interface Relay {
  instanceId: string;
  connect(peer: RelayWsPeer): RelayConnection;
  /** Write a line to the relay log tail (surfaced by system.status logs). */
  log(message: string): void;
}

/** Pairing admin is install-token scope only — device peers are refused. */
const PAIRING_ADMIN_METHODS = new Set([
  "pairing.offer",
  "pairing.disable",
  "devices.list",
  "devices.revoke",
]);

/* Pairing admin only: `folders.add` opened to device peers for #238, but
   per-call — a phone may write only home-scoped recents (checked below), so
   the `folders.detail` git-probe gate still can't be widened past home. */
const DEVICE_FORBIDDEN_METHODS = PAIRING_ADMIN_METHODS;

/* Per-namespace handler modules extracted from this file's handle()
   (#441): flat method -> handler lookup, one dispatch hop as before. */
const METHOD_HANDLERS: ReadonlyMap<
  string,
  (c: RelayCtx) => Promise<false | undefined>
> = new Map([
  ["session.hello", handleHandshake],
  ["session.ping", handleHandshake],
  ["employees.list", handleDirectory],
  ["employees.create", handleDirectory],
  ["employees.update", handleDirectory],
  ["employees.remove", handleDirectory],
  ["channels.list", handleDirectory],
  ["folders.list", handleDirectory],
  ["folders.add", handleDirectory],
  ["folders.detail", handleDirectory],
  ["folders.browse", handleDirectory],
  ["folders.discover", handleDirectory],
  ["profile.get", handleDirectory],
  ["profile.update", handleDirectory],
  ["channels.openDm", handleDirectory],
  ["conversations.list", handleConversations],
  ["conversations.summaries", handleConversations],
  ["conversations.open", handleConversations],
  ["conversations.update", handleConversations],
  ["conversations.rewind", handleConversations],
  ["conversations.moveFolder", handleConversations],
  ["conversations.setModel", handleConversations],
  ["conversations.setAccess", handleConversations],
  ["conversations.prs", handleConversations],
  ["messages.setCheckpoint", handleMessages],
  ["messages.list", handleMessages],
  ["messages.post", handleMessages],
  ["messages.remove", handleMessages],
  ["messages.drop", handleMessages],
  ["messages.claim", handleMessages],
  ["messages.send", handleMessages],
  ["messages.search", handleMessages],
  ["attachments.get", handleMessages],
  ["channel.subscribe", handleChannel],
  ["channel.unsubscribe", handleChannel],
  ["harness.register", handleHarness],
  ["harness.report", handleHarness],
  ["system.status", handleHarness],
  ["asks.open", handleAsks],
  ["asks.respond", handleAsks],
  ["asks.list", handleAsks],
  ["settings.get", handleSettings],
  ["settings.set", handleSettings],
  ["turns.interrupt", handleTurns],
  ["session.events", handleHostEvents],
  ["engine.event", handleHostEvents],
  ["workbench.open", handleHostEvents],
  ["pairing.offer", handlePairing],
  ["pairing.disable", handlePairing],
  ["devices.list", handlePairing],
  ["devices.revoke", handlePairing],
  ["push.register", handlePairing],
  ["push.unregister", handlePairing],
  ["push.visibility", handlePairing],
]);

/**
 * JSON-RPC 2.0 over one ws connection, with T3-style snapshot + replay
 * (channel.subscribe afterSeq → replay missed frames live-buffered then
 * `channel.synced`; gap too large / no cursor → `channel.snapshot` first).
 * Ordering rule that makes replay lossless: the peer joins the subscriber set
 * BEFORE the snapshot/replay is computed, so concurrent writes arrive as live
 * `message.created` frames the client dedupes by seq.
 */
export function createRelay(options: RelayOptions): Relay {
  const store = options.store;
  const protocolVersion = options.protocolVersion ?? APP_PROTOCOL_VERSION;
  const relayVersion = options.relayVersion ?? "0.0.0";
  const maxReplay = options.maxReplay ?? 1000;
  const snapshotLimit = options.snapshotLimit ?? 200;
  const instanceId = randomUUID();
  const subscribers = new Map<string, Set<RelayWsPeer>>();
  /** Every peer with a successful `session.hello` — receives broadcasts. */
  const helloedPeers = new Set<RelayWsPeer>();
  /** helloed phone clients by peer → device id (#153); revoke closes them. */
  const devicePeers = new Map<RelayWsPeer, string>();
  const now = options.now ?? (() => Date.now());
  const homeDir = options.homeDir ?? homedir();
  const heartbeatFreshMs = options.heartbeatFreshMs ?? 45_000;
  const logTail = options.logTail ?? createLogTail();
  const log = (message: string) => logTail.log(message);
  const attachmentStore = options.attachments ?? createMemoryAttachmentStore();

  /**
   * Validate inline attachments and park their bytes (issue #31): the decoded
   * body must be clean base64, image/* (schema already enforced), and under
   * MAX_ATTACHMENT_BYTES — oversize is the typed `attachment_too_large`. All
   * inputs validate before any blob lands so a bad batch stores nothing.
   */
  const storeAttachments = async (
    inputs: AttachmentInput[] | undefined,
  ): Promise<MessageAttachment[] | undefined> => {
    if (!inputs?.length) return undefined;
    const decoded = inputs.map((input) => {
      const bytes = Buffer.from(input.dataBase64, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== input.dataBase64) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "attachment dataBase64 is not valid base64",
          { name: input.name },
        );
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new RpcError(
          JsonRpcCode.attachmentTooLarge,
          "attachment_too_large",
          `attachment "${input.name || "image"}" is ${bytes.length} bytes — the cap is ${MAX_ATTACHMENT_BYTES}`,
          {
            limit: MAX_ATTACHMENT_BYTES,
            sizeBytes: bytes.length,
            name: input.name,
          },
        );
      }
      return { input, bytes };
    });
    const refs: MessageAttachment[] = [];
    for (const { input, bytes } of decoded) {
      refs.push(
        await attachmentStore.put({
          name: input.name,
          mimeType: input.mimeType,
          bytes,
        }),
      );
    }
    return refs;
  };

  /** Roll back stored blobs when the message write itself failed. */
  const dropAttachments = (refs: MessageAttachment[] | undefined) => {
    if (!refs) return;
    for (const ref of refs) attachmentStore.remove(ref.id).catch(() => {});
  };
  /** Failed version handshakes — lets system.status name the stale side. */
  const rejectedHandshakes: RejectedHandshake[] = [];
  let host: HostRecord | null = null;
  let lastHostDisconnectedAt: number | undefined;

  const recordRejection = (rejection: RejectedHandshake) => {
    rejectedHandshakes.push(rejection);
    if (rejectedHandshakes.length > 20) rejectedHandshakes.shift();
  };

  /**
   * In-flight `agents.*`/`models.*`/`conversations.rewind` calls forwarded
   * to the engine host. Passthrough entries pipe the answer to `caller`;
   * relay-initiated calls (`conversations.rewind`) carry resolve/reject
   * instead and `callHost` awaits them.
   */
  const hostCalls = new Map<
    string,
    {
      caller: RelayWsPeer;
      callerId: JsonRpcRequest["id"];
      hostPeer: RelayWsPeer;
      timer: ReturnType<typeof setTimeout>;
      resolve?: (result: unknown) => void;
      reject?: (error: RpcError) => void;
    }
  >();
  let hostCallSeq = 0;
  const hostCallTimeoutMs = options.hostCallTimeoutMs ?? 15_000;

  const emit = (
    channelId: string,
    method: string,
    params: unknown,
    except?: RelayWsPeer,
  ) => {
    const peers = subscribers.get(channelId);
    if (!peers) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const peer of peers) if (peer !== except) peer.send(frame);
  };

  /** To every helloed peer — used for `channel.created`. */
  const broadcast = (method: string, params: unknown) => {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const peer of helloedPeers) peer.send(frame);
  };

  /* A device insert/revoke can also come from the HTTP exchange (the phone),
     so the pairing service owns the change signal; session re-broadcasts. */
  options.pairing?.setOnDevicesChanged(() => {
    void options.pairing?.listDevices().then((devices) => {
      broadcast("devices.changed", { devices });
    });
  });

  const isHost = (peer: RelayWsPeer) => host !== null && host.peer === peer;

  const requireHost = (peer: RelayWsPeer) => {
    if (!isHost(peer)) {
      throw new RpcError(
        JsonRpcCode.forbidden,
        "forbidden",
        "only the registered engine host may call this",
      );
    }
  };

  /** `push.*` is device scope — the caller's deviceId is its identity. */
  const requireDevice = (peer: RelayWsPeer): string => {
    const deviceId = devicePeers.get(peer);
    if (!deviceId) {
      throw new RpcError(
        JsonRpcCode.forbidden,
        "forbidden",
        "push methods are for paired devices",
      );
    }
    return deviceId;
  };

  const emitMessage = (channelId: string, message: unknown) =>
    emit(channelId, "message.created", { channelId, message });

  const emitMessageChanged = (
    channelId: string,
    message: unknown,
    flags?: string[],
  ) => emit(channelId, "message.changed", { channelId, message, flags });

  const emitConversation = (channelId: string, conversation: unknown) =>
    emit(channelId, "conversation.updated", { channelId, conversation });

  /**
   * Forward a passthrough call to the registered engine host as a fresh
   * JSON-RPC request (`hr-N`); the host's response frame is correlated back
   * to the caller in `receive()`. No host → `engine_unavailable`.
   */
  const forwardToHost = (
    caller: RelayWsPeer,
    callerId: JsonRpcRequest["id"],
    method: string,
    params: unknown,
  ) => {
    if (!host) {
      throw new RpcError(
        JsonRpcCode.unavailable,
        "engine_unavailable",
        "no engine host connected",
      );
    }
    const hostReqId = `hr-${++hostCallSeq}`;
    const timer = setTimeout(() => {
      const call = hostCalls.get(hostReqId);
      hostCalls.delete(hostReqId);
      if (call) {
        respondError(
          call.caller,
          call.callerId,
          JsonRpcCode.unavailable,
          "engine_unavailable",
          "engine host did not answer in time",
        );
      }
    }, hostCallTimeoutMs);
    hostCalls.set(hostReqId, { caller, callerId, hostPeer: host.peer, timer });
    host.peer.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: hostReqId,
        method,
        params: params ?? {},
      }),
    );
  };

  /**
   * A relay-initiated engine-host call (#134): the relay itself needs the
   * host's answer before it can mark messages rewound, so unlike
   * `forwardToHost` this returns a promise the handler awaits. The host's
   * numeric code maps back to an AppErrorCode so `conflict` (a turn still
   * running) reaches the caller intact.
   */
  const callHost = (
    method: string,
    params: unknown,
    timeoutMs = hostCallTimeoutMs,
  ): Promise<unknown> => {
    if (!host) {
      return Promise.reject(
        new RpcError(
          JsonRpcCode.unavailable,
          "engine_unavailable",
          "no engine host connected",
        ),
      );
    }
    const hostPeer = host.peer;
    const hostReqId = `hr-${++hostCallSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hostCalls.delete(hostReqId);
        reject(
          new RpcError(
            JsonRpcCode.unavailable,
            "engine_unavailable",
            "engine host did not answer in time",
          ),
        );
      }, timeoutMs);
      hostCalls.set(hostReqId, {
        caller: hostPeer,
        callerId: hostReqId,
        hostPeer,
        timer,
        resolve,
        reject,
      });
      hostPeer.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: hostReqId,
          method,
          params: params ?? {},
        }),
      );
    });
  };

  /** A response frame (no `method`, has `result`|`error`) answers a forwarded call. */
  const resolveHostCall = (
    peer: RelayWsPeer,
    frame: {
      id: unknown;
      result?: unknown;
      error?: unknown;
    },
  ) => {
    const call = hostCalls.get(String(frame.id));
    if (!call || call.hostPeer !== peer) return;
    hostCalls.delete(String(frame.id));
    clearTimeout(call.timer);
    const error = frame.error as
      | { code?: unknown; message?: unknown; data?: unknown }
      | undefined;
    if (error) {
      const numeric =
        typeof error.code === "number" ? error.code : JsonRpcCode.internal;
      /* Engine INVALID_STATE (-32003) — "a turn is running / session is in
         the wrong state" — is a state conflict, not a generic failure. */
      const appCode: AppErrorCode =
        numeric === JsonRpcCode.unavailable ||
        numeric === JsonRpcCode.backendDown
          ? "engine_unavailable"
          : numeric === JsonRpcCode.conflict || numeric === -32_003
            ? "conflict"
            : "engine_error";
      if (call.reject) {
        call.reject(
          new RpcError(
            numeric,
            appCode,
            typeof error.message === "string"
              ? error.message
              : "engine call failed",
            { engine: error.data },
          ),
        );
        return;
      }
      respondError(
        call.caller,
        call.callerId,
        numeric,
        appCode,
        typeof error.message === "string"
          ? error.message
          : "engine call failed",
        { engine: error.data },
      );
      return;
    }
    if (call.resolve) {
      call.resolve(frame.result ?? null);
      return;
    }
    respond(call.caller, call.callerId, frame.result ?? null);
  };

  const respond = (
    peer: RelayWsPeer,
    id: JsonRpcRequest["id"],
    result: unknown,
  ) => peer.send(JSON.stringify({ jsonrpc: "2.0", id, result }));

  const respondError = (
    peer: RelayWsPeer,
    id: JsonRpcRequest["id"] | null,
    numericCode: number,
    appCode: AppErrorCode,
    message: string,
    data?: Record<string, unknown>,
  ) =>
    peer.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: numericCode,
          message,
          data: { code: appCode, ...(data ?? {}) },
        },
      }),
    );

  /** Everything the moved case bodies closed over (#441); `host` and
      `lastHostDisconnectedAt` ride accessors onto the closure lets. */
  const shared: RelaySharedCtx = {
    options,
    store,
    protocolVersion,
    relayVersion,
    maxReplay,
    snapshotLimit,
    instanceId,
    subscribers,
    helloedPeers,
    devicePeers,
    now,
    homeDir,
    heartbeatFreshMs,
    logTail,
    log,
    attachmentStore,
    storeAttachments,
    dropAttachments,
    rejectedHandshakes,
    emit,
    broadcast,
    emitMessage,
    emitMessageChanged,
    emitConversation,
    isHost,
    requireHost,
    requireDevice,
    recordRejection,
    forwardToHost,
    callHost,
    respond,
    get host() {
      return host;
    },
    set host(v) {
      host = v;
    },
    get lastHostDisconnectedAt() {
      return lastHostDisconnectedAt;
    },
  };

  async function handle(
    peer: RelayWsPeer,
    state: { helloed: boolean; subscriptions: Set<string> },
    request: JsonRpcRequest,
  ): Promise<void> {
    const { id, method, params } = request;

    if (method !== "session.hello" && !state.helloed) {
      respondError(
        peer,
        id,
        JsonRpcCode.unauthenticated,
        "unauthenticated",
        "unauthenticated: call session.hello first",
      );
      return;
    }

    /* Paired phones get the whole app surface but not pairing admin: a
       stolen `devcred_` could otherwise mint fresh credentials (surviving
       its own revoke) or drop other devices. devicePeers is set inside
       session.hello before the credential check resolves, so it is also
       the marker that separates device peers from token-authed ones. */
    if (devicePeers.has(peer) && DEVICE_FORBIDDEN_METHODS.has(method)) {
      respondError(
        peer,
        id,
        JsonRpcCode.forbidden,
        "forbidden",
        "paired devices can't administer pairing",
      );
      return;
    }

    const c = Object.create(shared) as RelayCtx;
    Object.assign(c, { peer, state, id, method, params });

    try {
      const passthrough = (
        ENGINE_PASSTHROUGH_METHODS as readonly string[]
      ).includes(method)
        ? (method as EnginePassthroughMethod)
        : undefined;
      if (passthrough) {
        const parsed = ENGINE_PASSTHROUGH_PARAMS[passthrough].safeParse(
          params ?? {},
        );
        if (!parsed.success) throw badParams(parsed.error.issues);
        forwardToHost(peer, id, passthrough, parsed.data);
        return;
      }
      const handler = METHOD_HANDLERS.get(method);
      if (!handler) {
        throw new RpcError(
          JsonRpcCode.methodNotFound,
          "internal",
          `unknown method ${method}`,
        );
      }
      await handler(c);
      return;
    } catch (error) {
      if (error instanceof RpcError) {
        respondError(
          peer,
          id,
          error.numericCode,
          error.appCode,
          error.message,
          error.data,
        );
      } else {
        respondError(
          peer,
          id,
          JsonRpcCode.internal,
          "internal",
          error instanceof Error ? error.message : "internal error",
        );
      }
    }
  }

  return {
    instanceId,
    log,
    connect(peer: RelayWsPeer): RelayConnection {
      const state = { helloed: false, subscriptions: new Set<string>() };
      return {
        async receive(data: string) {
          let raw: unknown;
          try {
            raw = JSON.parse(data);
          } catch {
            respondError(
              peer,
              null,
              JsonRpcCode.parseError,
              "internal",
              "parse error",
            );
            return;
          }
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            respondError(
              peer,
              null,
              JsonRpcCode.invalidRequest,
              "internal",
              "invalid request",
            );
            return;
          }
          const candidate = raw as Record<string, unknown>;
          // A response frame (result|error, no method) resolves a call the
          // relay forwarded to the engine host for some other peer.
          if (
            typeof candidate.method !== "string" &&
            candidate.id !== undefined &&
            ("result" in candidate || "error" in candidate)
          ) {
            resolveHostCall(
              peer,
              candidate as { id: unknown; result?: unknown; error?: unknown },
            );
            return;
          }
          if (
            typeof candidate.method !== "string" ||
            candidate.id === undefined
          ) {
            respondError(
              peer,
              null,
              JsonRpcCode.invalidRequest,
              "internal",
              "invalid request",
            );
            return;
          }
          if (
            typeof candidate.id !== "string" &&
            typeof candidate.id !== "number"
          ) {
            respondError(
              peer,
              null,
              JsonRpcCode.invalidRequest,
              "internal",
              "invalid request id",
            );
            return;
          }
          await handle(peer, state, candidate as unknown as JsonRpcRequest);
        },
        closed() {
          for (const channelId of state.subscriptions) {
            subscribers.get(channelId)?.delete(peer);
          }
          state.subscriptions.clear();
          helloedPeers.delete(peer);
          const deviceId = devicePeers.get(peer);
          devicePeers.delete(peer);
          /* A dead/backgrounded phone's suppression dies with the socket —
             pushes resume rather than staying muted by a stale report. But
             only when this was the device's LAST socket: a reconnect's new
             hello + fresh visibility report must not be wiped by the old
             socket's late close. */
          if (deviceId && ![...devicePeers.values()].includes(deviceId)) {
            options.push?.deviceGone(deviceId);
          }
          if (host?.peer === peer) {
            log(`harness ${host.hostId} disconnected`);
            host = null;
            lastHostDisconnectedAt = now();
            broadcast("host.changed", { connected: false });
          }
          // Fail or drop every forwarded call this peer is a party to.
          for (const [reqId, call] of hostCalls) {
            if (call.hostPeer === peer) {
              hostCalls.delete(reqId);
              clearTimeout(call.timer);
              if (call.reject) {
                call.reject(
                  new RpcError(
                    JsonRpcCode.unavailable,
                    "engine_unavailable",
                    "engine host disconnected",
                  ),
                );
              } else {
                respondError(
                  call.caller,
                  call.callerId,
                  JsonRpcCode.unavailable,
                  "engine_unavailable",
                  "engine host disconnected",
                );
              }
            } else if (call.caller === peer) {
              hostCalls.delete(reqId);
              clearTimeout(call.timer);
            }
          }
        },
      };
    },
  };
}
