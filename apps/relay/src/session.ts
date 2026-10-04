import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  APP_PROTOCOL_VERSION,
  type AppErrorCode,
  AsksListParams,
  AsksOpenParams,
  AsksRespondParams,
  type AttachmentInput,
  AttachmentsGetParams,
  ChannelSubscribeParams,
  ChannelsOpenDmParams,
  ChannelUnsubscribeParams,
  ConversationsListParams,
  ConversationsOpenParams,
  ConversationsPrsParams,
  type ConversationsRewindHostParams,
  type ConversationsRewindHostResult,
  ConversationsRewindParams,
  ConversationsSetAccessParams,
  ConversationsSetModelParams,
  ConversationsSummariesParams,
  ConversationsUpdateParams,
  DevicesRevokeParams,
  EmployeesCreateParams,
  EmployeesRemoveParams,
  EmployeesUpdateParams,
  ENGINE_PASSTHROUGH_METHODS,
  ENGINE_PASSTHROUGH_PARAMS,
  EngineEventParams,
  type EngineHostState,
  type EnginePassthroughMethod,
  FoldersAddParams,
  FoldersBrowseParams,
  FoldersDetailParams,
  FoldersDiscoverParams,
  FoldersListParams,
  HarnessRegisterParams,
  HarnessReportParams,
  type HarnessStatusReport,
  HelloParams,
  type JsonRpcRequest,
  MAX_ATTACHMENT_BYTES,
  type MessageAttachment,
  MessagesClaimParams,
  MessagesDropParams,
  MessagesListParams,
  MessagesPostParams,
  MessagesRemoveParams,
  MessagesSearchParams,
  MessagesSendParams,
  MessagesSetCheckpointParams,
  type ProfileConnection,
  ProfileUpdateParams,
  PushRegisterParams,
  PushUnregisterParams,
  PushVisibilityParams,
  SessionEventsParams,
  SessionPingParams,
  SettingsGetParams,
  SettingsSetParams,
  SystemStatusParams,
  TurnsInterruptParams,
  type WelcomeResult,
  WorkbenchOpenParams,
  WS_CLOSE_DEVICE_REVOKED,
} from "@lilos/contracts/app";
import {
  ConversationAccess,
  type ConversationAccess as ConversationAccessT,
} from "@lilos/contracts/engine";
import type { ForgePrsResult } from "@lilos/contracts/host";
import { collapsePath, resolveUnderHome } from "@lilos/host";
import {
  type AttachmentStore,
  createMemoryAttachmentStore,
} from "./attachments";
import { createLogTail, type LogTail } from "./logtail";
import type { PairingService } from "./pairing";
import type { PushFanout } from "./push";
import { buildSystemStatus, type RejectedHandshake } from "./status";
import {
  type ConversationPatch,
  noFolderDedupeKey,
  type RelayStore,
} from "./store";

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

/** Numeric JSON-RPC error codes; the app-level AppErrorCode rides in `data.code`. */
const JsonRpcCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthenticated: -32001,
  protocolVersionMismatch: -32002,
  forbidden: -32003,
  notFound: -32004,
  unavailable: -32005,
  conflict: -32009,
  attachmentTooLarge: -32010,
} as const;

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

/** The peer that has `harness.register`ed — the single engine host. */
interface HostRecord {
  peer: RelayWsPeer;
  hostId: string;
  /** Claimed build + protocol versions from the register handshake. */
  version: string;
  protocolVersion: number;
  registeredAt: number;
  lastReportAt?: number;
  engine?: { state: EngineHostState; detail?: string };
  /** Latest telemetry payload from harness.report.status. */
  status?: HarnessStatusReport;
}

class RpcError extends Error {
  constructor(
    readonly numericCode: number,
    readonly appCode: AppErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const badParams = (issues: unknown) =>
  new RpcError(JsonRpcCode.invalidParams, "invalid_params", "invalid params", {
    issues,
  });

/** #413: order-insensitive signature of a report's connect rows — a roster
    reported in a different order is not a change worth broadcasting. */
const connectSignature = (rows: ProfileConnection[] | undefined): string =>
  rows === undefined
    ? ""
    : JSON.stringify(
        [...rows].sort((a, b) => a.profile.localeCompare(b.profile)),
      );

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

  const emitMessageChanged = (channelId: string, message: unknown) =>
    emit(channelId, "message.changed", { channelId, message });

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
        numeric === JsonRpcCode.unavailable
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
      switch (method) {
        case "session.hello": {
          if (state.helloed) {
            /* One hello per connection: re-hello would let a token peer
               retag itself as a device (then a revoke kills the local
               socket) or a device climb back to token scope. */
            throw new RpcError(
              JsonRpcCode.invalidRequest,
              "internal",
              "session.hello already completed on this connection",
            );
          }
          const parsed = HelloParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const hello = parsed.data;
          /** Two auth shapes (#153): the local install token, or a paired
              device's `deviceId` + `credential` exchanged from a grant. */
          if ("token" in hello) {
            if (hello.token !== options.token) {
              log("session.hello rejected: bad token");
              throw new RpcError(
                JsonRpcCode.unauthenticated,
                "unauthenticated",
                "bad auth token",
              );
            }
          } else {
            /* Tag as a device peer BEFORE the auth await: a devices.revoke
               processed while authenticateDevice is in flight must find
               this peer — otherwise a revoked device keeps a live,
               fully-authed socket until it disconnects. Untag on failure. */
            devicePeers.set(peer, hello.deviceId);
            const device = options.pairing
              ? await options.pairing.authenticateDevice(
                  hello.deviceId,
                  hello.credential,
                )
              : null;
            if (!device) {
              devicePeers.delete(peer);
              log("session.hello rejected: bad device credential");
              throw new RpcError(
                JsonRpcCode.unauthenticated,
                "unauthenticated",
                "bad device credential",
              );
            }
          }
          if (hello.protocolVersion !== protocolVersion) {
            /* Undo the device-branch pre-tag — the hello fails here. */
            devicePeers.delete(peer);
            recordRejection({
              kind: "hello",
              claimed: hello.protocolVersion,
              at: now(),
            });
            log(
              `session.hello rejected: client spoke protocol ${hello.protocolVersion}, relay is ${protocolVersion}`,
            );
            throw new RpcError(
              JsonRpcCode.protocolVersionMismatch,
              "protocol_version_mismatch",
              "protocol version mismatch",
              {
                update:
                  hello.protocolVersion > protocolVersion ? "server" : "client",
                clientVersion: hello.protocolVersion,
                serverVersion: protocolVersion,
              },
            );
          }
          state.helloed = true;
          helloedPeers.add(peer);
          log(
            `session.hello accepted (client ${hello.client?.name ?? "app"} ${hello.client?.version ?? ""})`.trim(),
          );
          const welcome: WelcomeResult = {
            protocolVersion,
            relayVersion,
            instanceId,
            engineHost: {
              connected: host !== null,
              state: host?.engine?.state,
              detail: host?.engine?.detail,
              capabilities: host?.status?.capabilities,
              models: host?.status?.models,
              providers: host?.status?.providers,
              defaultModel: host?.status?.defaultModel,
              defaultProvider: host?.status?.defaultProvider,
            },
          };
          respond(peer, id, welcome);
          return;
        }
        case "session.ping": {
          const parsed = SessionPingParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          /* #154 keep-vs-replace probe: the mobile supervisor pings the live
             socket on foreground before deciding to replace it. Answers the
             run identity so a probe across a relay restart also catches the
             instanceId change. */
          respond(peer, id, { ok: true, instanceId });
          return;
        }
        case "employees.list": {
          respond(peer, id, { employees: await store.listEmployees() });
          return;
        }
        case "employees.create": {
          const parsed = EmployeesCreateParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const employee = await store.createEmployee(parsed.data);
          broadcast("employee.upserted", { employee });
          respond(peer, id, { employee });
          return;
        }
        case "employees.update": {
          const parsed = EmployeesUpdateParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const { id: employeeId, ...patch } = parsed.data;
          const employee = await store.updateEmployee(employeeId, patch);
          if (!employee) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "employee not found",
            );
          }
          broadcast("employee.upserted", { employee });
          respond(peer, id, { employee });
          return;
        }
        case "employees.remove": {
          const parsed = EmployeesRemoveParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const removed = await store.removeEmployee(parsed.data.id);
          if (!removed) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "employee not found",
            );
          }
          for (const channelId of removed.channelIds) {
            subscribers.delete(channelId);
            broadcast("channel.removed", { channelId });
          }
          broadcast("employee.removed", { employeeId: parsed.data.id });
          respond(peer, id, { ok: true });
          return;
        }
        case "channels.list": {
          respond(peer, id, { channels: await store.listChannels() });
          return;
        }
        case "folders.list": {
          const parsed = FoldersListParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(peer, id, { folders: await store.listRecentFolders() });
          return;
        }
        case "folders.add": {
          const parsed = FoldersAddParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          let path = parsed.data.path;
          if (devicePeers.has(peer)) {
            /* The phone may add only what its browser could have listed —
               a real folder under the Mac's home (#238). The stored path
               is the canonical `~/x` form of the resolved one. */
            const abs = resolveUnderHome(path, homeDir);
            if (!abs) {
              throw new RpcError(
                JsonRpcCode.forbidden,
                "forbidden",
                "path is outside the Mac's home folder",
              );
            }
            path = collapsePath(abs, homeDir);
          }
          respond(peer, id, { folder: await store.addRecentFolder(path) });
          return;
        }
        case "folders.detail": {
          /* Branch/workstream probe of a recents-listed folder (#156): the
             phone (device scope) can read workspaces of folders the Mac
             already lists — nothing wider. The probe itself runs on the
             session machine, so the call forwards to the harness. */
          const parsed = FoldersDetailParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const recents = await store.listRecentFolders();
          if (!recents.some((f) => f.path === parsed.data.path)) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "folder is not in the recents list",
            );
          }
          forwardToHost(peer, id, "folders.detail", parsed.data);
          return;
        }
        case "folders.browse": {
          /* The phone's folder browser (#238): forwarded to the harness,
             which enforces the home-folder boundary server-side. */
          const parsed = FoldersBrowseParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          forwardToHost(peer, id, "folders.browse", parsed.data);
          return;
        }
        case "folders.discover": {
          /* "Found on this Mac" for the phone browser (#238) — same scan
             roots as the web dialog, computed by the harness. */
          const parsed = FoldersDiscoverParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          forwardToHost(peer, id, "folders.discover", parsed.data);
          return;
        }
        case "profile.get": {
          respond(peer, id, { profile: await store.getProfile() });
          return;
        }
        case "profile.update": {
          const parsed = ProfileUpdateParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const profile = await store.updateProfile(parsed.data);
          broadcast("profile.updated", { profile });
          respond(peer, id, { profile });
          return;
        }
        case "channels.openDm": {
          const parsed = ChannelsOpenDmParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const { channel, created } = await store.openDmChannel(
            parsed.data.employeeId,
          );
          if (created) broadcast("channel.created", { channel });
          respond(peer, id, { channel });
          return;
        }
        case "conversations.list": {
          const parsed = ConversationsListParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(peer, id, {
            conversations: await store.listConversations({
              channelId: parsed.data.channelId,
              includeArchived: parsed.data.includeArchived,
            }),
          });
          return;
        }
        case "conversations.summaries": {
          const parsed = ConversationsSummariesParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(peer, id, {
            summaries: await store.listConversationSummaries({
              channelId: parsed.data.channelId,
              includeArchived: parsed.data.includeArchived,
            }),
          });
          return;
        }
        case "conversations.open": {
          const parsed = ConversationsOpenParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          if (!(await store.getChannel(parsed.data.channelId))) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel not found",
            );
          }
          const attachments = await storeAttachments(parsed.data.attachments);
          /* #106 AC-3: the pill's level lands on the row — an explicit
             `access` param wins; otherwise Settings' `defaultAccess`, else
             Ask. Stored values pass through the enum guard so a corrupt
             setting can't mint a third level. */
          const storedDefault = ConversationAccess.safeParse(
            await store.getSetting("defaultAccess"),
          );
          const access: ConversationAccessT =
            parsed.data.access ??
            (storedDefault.success ? storedDefault.data : "ask");
          try {
            const { conversation, rootMessage } = await store.openConversation({
              ...parsed.data,
              access,
              attachments,
              /* #137: a title given at open is user-chosen from a client,
                 engine-owned ("auto") from the host; empty → placeholder. */
              titleSource: isHost(peer) ? "auto" : "user",
            });
            emitMessage(conversation.channelId, rootMessage);
            emitConversation(conversation.channelId, conversation);
            respond(peer, id, { conversation, rootMessage });
          } catch (error) {
            dropAttachments(attachments);
            if (error instanceof RpcError) throw error;
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel or conversation not found",
            );
          }
          return;
        }
        case "conversations.update": {
          const parsed = ConversationsUpdateParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          // engineRef/state/model(+provider/effort/fast)/deliveredSeq are
          // owned by the engine host (the pick lands once the engine acks
          // `session.setModel`); title/archive are user-facing fields any
          // client may set. Key presence (`in`) is the write intent — an
          // explicit `null` clear follows the same host-only rule as a value.
          const HOST_KEYS = [
            "engineRef",
            "state",
            "model",
            "provider",
            "effort",
            "fast",
            "deliveredSeq",
          ] as const;
          if (HOST_KEYS.some((k) => k in parsed.data) && !isHost(peer)) {
            throw new RpcError(
              JsonRpcCode.forbidden,
              "forbidden",
              "only the registered engine host may write engineRef/state/model/provider/effort/fast/deliveredSeq",
            );
          }
          const { conversationId, ...rest } = parsed.data;
          /* #137 AC-2: title provenance is caller identity — a host write is
             the engine titling its session ("auto", guarded: never over a
             user name); any other client's title is a rename ("user"). */
          const patch: ConversationPatch = {
            ...rest,
            ...("title" in rest
              ? {
                  titleSource: isHost(peer)
                    ? ("auto" as const)
                    : ("user" as const),
                }
              : {}),
          };
          const conversation = await store.updateConversation(
            conversationId,
            patch,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          emitConversation(conversation.channelId, conversation);
          respond(peer, id, { conversation });
          return;
        }
        case "messages.setCheckpoint": {
          const parsed = MessagesSetCheckpointParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          requireHost(peer);
          const message = await store.setMessageCheckpoint(
            parsed.data.messageId,
            parsed.data.checkpoint,
          );
          if (!message || message.channelId !== parsed.data.channelId) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "message not found",
            );
          }
          respond(peer, id, { message });
          return;
        }
        case "conversations.rewind": {
          const parsed = ConversationsRewindParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          const target = await store.getMessage(parsed.data.messageId);
          if (!target || target.conversationId !== conversation.id) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "message not found",
            );
          }
          // The rewind point is a user turn's own message — an employee or
          // system line has no folder checkpoint of its own to return to.
          if (target.authorKind !== "user" || target.rewound) {
            throw new RpcError(
              JsonRpcCode.conflict,
              "conflict",
              target.rewound
                ? "message is already rewound"
                : "only a user message can be a rewind point",
            );
          }
          /* toTurn for the engine = the visible user turns that stay. */
          const before = await store.listMessages(conversation.channelId, {
            conversationId: conversation.id,
          });
          const toTurn = before.messages.filter(
            (m) => m.authorKind === "user" && m.seq < target.seq,
          ).length;
          /* The engine host owns the restore + engine-side rewind; on its
             success the relay marks the tail and tells subscribers. */
          const hostParams: ConversationsRewindHostParams = {
            conversationId: conversation.id,
            engineRef: conversation.engineRef,
            messageId: target.id,
            checkpoint: target.checkpoint ?? null,
            cwd: conversation.cwd ?? null,
            fromSeq: target.seq,
            toTurn,
          };
          const hostResult = (await callHost(
            "conversations.rewind",
            hostParams,
            /* A folder restore can touch thousands of files — well past the
               generic host-call timeout. */
            120_000,
          )) as ConversationsRewindHostResult | null;
          const engineRewound = hostResult?.engineRewound === true;
          const filesRestored = hostResult?.filesRestored === true;
          const marked = await store.markRewound(conversation.id, target.seq);
          const removedIds = marked.map((m) => m.id);
          emit(conversation.channelId, "conversation.rewound", {
            channelId: conversation.channelId,
            conversationId: conversation.id,
            fromSeq: target.seq,
            messageId: target.id,
            engineRewound,
            removedIds,
          });
          /* The plain note (AC-3) is a relay-owned system message: written
             AFTER the mark so it survives, no host round-trip needed. It says
             exactly what happened — a message can predate checkpoints or
             carry a failed stamp, so "files restored" is only claimed when
             the host actually restored them. */
          const parts = [
            `Rewound to before your message — ${marked.length} message${marked.length === 1 ? "" : "s"} dropped`,
          ];
          if (filesRestored)
            parts.push("files restored to the earlier checkpoint");
          else
            parts.push(
              "no file checkpoint was stored for it — the folder kept its current state",
            );
          if (!engineRewound)
            parts.push(
              "this session's transport can't rewind the agent's memory — it still remembers the later messages",
            );
          const note = `${parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.`;
          const { message: noteMessage } = await store.appendMessage({
            channelId: conversation.channelId,
            conversationId: conversation.id,
            authorId: "system",
            authorKind: "system",
            text: note,
          });
          emitMessage(conversation.channelId, noteMessage);
          respond(peer, id, {
            message: target,
            engineRewound,
            filesRestored,
            removedCount: marked.length,
            removedIds,
          });
          return;
        }
        case "messages.list": {
          const parsed = MessagesListParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          try {
            const page = await store.listMessages(parsed.data.channelId, {
              conversationId: parsed.data.conversationId,
              afterSeq: parsed.data.afterSeq,
              limit: parsed.data.limit,
              includeRewound: parsed.data.includeRewound,
              includeDropped: parsed.data.includeDropped,
            });
            respond(peer, id, page);
          } catch {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel not found",
            );
          }
          return;
        }
        case "messages.post": {
          const parsed = MessagesPostParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          // Employee/system utterances are produced by the engine host only.
          if (parsed.data.authorKind !== "user" && !isHost(peer)) {
            throw new RpcError(
              JsonRpcCode.forbidden,
              "forbidden",
              "only the registered engine host may post non-user messages",
            );
          }
          const attachments = await storeAttachments(parsed.data.attachments);
          try {
            const { message, created } = await store.appendMessage({
              ...parsed.data,
              attachments,
            });
            // A dedupe hit is a no-op retry: answer with the stored message,
            // don't re-emit `message.created` to subscribers (the blobs
            // stored above for this retry are unreferenced — drop them).
            // The retired no-folder note is hidden from subscribers too.
            if (created && !noFolderDedupeKey(parsed.data.dedupeKey))
              emitMessage(message.channelId, message);
            else dropAttachments(attachments);
            respond(peer, id, { message });
          } catch (error) {
            dropAttachments(attachments);
            if (error instanceof RpcError) throw error;
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel or conversation not found",
            );
          }
          return;
        }
        /* #315 waiting-tray actions. All three broadcast `message.changed`
           so every subscribed surface (and the host's own queue) sees the
           flag flip — no `message.created`, the seq is unchanged. */
        case "messages.remove": {
          const parsed = MessagesRemoveParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const message = await store.getMessage(parsed.data.messageId);
          if (message?.authorKind !== "user") {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "message not found",
            );
          }
          if (message.removed) {
            respond(peer, id, { message });
            return;
          }
          const conversation = message.conversationId
            ? await store.getConversation(message.conversationId)
            : null;
          const deliveredSeq = conversation?.deliveredSeq ?? 0;
          /* Only a message the engine can't already have is removable: still
             past the delivered watermark, or parked in the not-sent tray. */
          if (!message.dropped && message.seq <= deliveredSeq) {
            throw new RpcError(
              JsonRpcCode.conflict,
              "conflict",
              "already delivered to the engine",
            );
          }
          const removed = await store.setMessageFlags(message.id, {
            removed: true,
            dropped: false,
          });
          emitMessageChanged(message.channelId, removed ?? message);
          respond(peer, id, { message: removed ?? message });
          return;
        }
        case "messages.drop": {
          const parsed = MessagesDropParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          /* The harness parks queued messages on Stop; a device never drops. */
          requireHost(peer);
          const message = await store.getMessage(parsed.data.messageId);
          if (message?.authorKind !== "user" || message.removed) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "message not found",
            );
          }
          if (message.dropped) {
            respond(peer, id, { message });
            return;
          }
          const dropped = await store.setMessageFlags(message.id, {
            dropped: true,
          });
          emitMessageChanged(message.channelId, dropped ?? message);
          respond(peer, id, { message: dropped ?? message });
          return;
        }
        case "messages.claim": {
          const parsed = MessagesClaimParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          /* Host-only (#377): the harness marks a send once its prompt
             commits to dispatch — the row leaves the waiting tray before
             `deliveredSeq` can cover it, so Remove is only ever offered
             on truly queued sends. Idempotent (reclaim on redelivery). */
          requireHost(peer);
          const message = await store.getMessage(parsed.data.messageId);
          if (message?.authorKind !== "user") {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "message not found",
            );
          }
          if (message.claimed) {
            respond(peer, id, { message });
            return;
          }
          const claimed = await store.setMessageFlags(message.id, {
            claimed: true,
          });
          emitMessageChanged(message.channelId, claimed ?? message);
          respond(peer, id, { message: claimed ?? message });
          return;
        }
        case "messages.send": {
          const parsed = MessagesSendParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const message = await store.getMessage(parsed.data.messageId);
          if (!message?.dropped || message.removed) {
            throw new RpcError(
              JsonRpcCode.conflict,
              "conflict",
              "message is not parked",
            );
          }
          const sent = await store.setMessageFlags(message.id, {
            dropped: false,
          });
          emitMessageChanged(message.channelId, sent ?? message);
          respond(peer, id, { message: sent ?? message });
          return;
        }
        case "messages.search": {
          const parsed = MessagesSearchParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(peer, id, {
            hits: await store.searchMessages(parsed.data),
          });
          return;
        }
        case "attachments.get": {
          const parsed = AttachmentsGetParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const stored = await attachmentStore.get(parsed.data.id);
          if (!stored) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "attachment not found",
            );
          }
          respond(peer, id, stored);
          return;
        }
        case "channel.subscribe": {
          const parsed = ChannelSubscribeParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const { channelId, afterSeq } = parsed.data;
          const channel = await store.getChannel(channelId);
          if (!channel) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel not found",
            );
          }
          // Register for live frames first so nothing lands between the read
          // below and the subscribe going live — seq dedupe absorbs the overlap.
          let peers = subscribers.get(channelId);
          if (!peers) {
            peers = new Set();
            subscribers.set(channelId, peers);
          }
          peers.add(peer);
          state.subscriptions.add(channelId);
          try {
            const gapTooLarge =
              afterSeq !== undefined &&
              (afterSeq > channel.lastSeq ||
                channel.lastSeq - afterSeq > maxReplay);
            if (afterSeq === undefined || gapTooLarge) {
              const page = await store.listMessages(channelId, {
                limit: snapshotLimit,
              });
              peer.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "channel.snapshot",
                  params: {
                    channelId,
                    messages: page.messages,
                    lastSeq: page.lastSeq,
                  },
                }),
              );
            } else {
              const page = await store.listMessages(channelId, { afterSeq });
              for (const message of page.messages) {
                peer.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: "message.created",
                    params: { channelId, message },
                  }),
                );
              }
            }
            // Asks carry no seq watermark: an ask that opened between the
            // client's seed read and this subscribe would otherwise be lost
            // for good (issue #148). Replay the channel's current set — live
            // ask events dedupe by id on the client, same as messages.
            for (const ask of await store.listAsks({ channelId })) {
              peer.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method:
                    ask.state === "resolved" ? "ask.resolved" : "ask.opened",
                  params: { channelId, ask },
                }),
              );
            }
            peer.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "channel.synced",
                params: { channelId, lastSeq: channel.lastSeq },
              }),
            );
            respond(peer, id, { channel });
          } catch (error) {
            peers.delete(peer);
            state.subscriptions.delete(channelId);
            throw error;
          }
          return;
        }
        case "channel.unsubscribe": {
          const parsed = ChannelUnsubscribeParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const { channelId } = parsed.data;
          subscribers.get(channelId)?.delete(peer);
          state.subscriptions.delete(channelId);
          respond(peer, id, { channelId });
          return;
        }
        case "harness.register": {
          const parsed = HarnessRegisterParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          // Same handshake rule as session.hello (issue #33): a mismatched
          // harness fails loudly here instead of registering half-spoken.
          if (parsed.data.protocolVersion !== protocolVersion) {
            recordRejection({
              kind: "register",
              claimed: parsed.data.protocolVersion,
              at: now(),
            });
            log(
              `harness.register rejected: spoke protocol ${parsed.data.protocolVersion} v${parsed.data.version}, relay is ${protocolVersion}`,
            );
            throw new RpcError(
              JsonRpcCode.protocolVersionMismatch,
              "protocol_version_mismatch",
              "protocol version mismatch",
              {
                update:
                  parsed.data.protocolVersion > protocolVersion
                    ? "relay"
                    : "harness",
                clientVersion: parsed.data.protocolVersion,
                serverVersion: protocolVersion,
              },
            );
          }
          if (host !== null && host.peer !== peer) {
            log("harness.register rejected: another host is registered");
            throw new RpcError(
              JsonRpcCode.conflict,
              "conflict",
              "an engine host is already registered",
            );
          }
          const wasEmpty = !host;
          if (!host) {
            host = {
              peer,
              hostId: `host_${randomUUID()}`,
              version: parsed.data.version,
              protocolVersion: parsed.data.protocolVersion,
              registeredAt: now(),
            };
          } else {
            host.version = parsed.data.version;
            host.protocolVersion = parsed.data.protocolVersion;
          }
          log(`harness.register accepted (${host.hostId} v${host.version})`);
          if (wasEmpty) broadcast("host.changed", { connected: true });
          respond(peer, id, {
            hostId: host.hostId,
            pending: await store.listPendingTurns(),
          });
          return;
        }
        case "harness.report": {
          const parsed = HarnessReportParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          requireHost(peer);
          if (host) {
            if (host.engine?.state !== parsed.data.engine.state) {
              log(
                `engine state ${host.engine?.state ?? "unknown"} -> ${parsed.data.engine.state}${parsed.data.engine.detail ? ` (${parsed.data.engine.detail})` : ""}`,
              );
            }
            host.engine = parsed.data.engine;
            host.lastReportAt = now();
            if (parsed.data.status) {
              /* #413: the DM notice and Settings → Engine read `connect` off
                 `system.status` — push the rows live when they change instead
                 of leaving surfaces on the next poll. */
              const prev = connectSignature(host.status?.connect);
              host.status = parsed.data.status;
              if (prev !== connectSignature(host.status.connect)) {
                broadcast("connect.changed", {
                  connect: host.status.connect,
                });
              }
            }
          }
          respond(peer, id, { ok: true });
          return;
        }
        case "system.status": {
          const parsed = SystemStatusParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(
            peer,
            id,
            buildSystemStatus({
              protocolVersion,
              relayVersion,
              now: now(),
              heartbeatFreshMs,
              host,
              lastHostDisconnectedAt,
              rejected: rejectedHandshakes,
              relayLogTail: (n) => logTail.tail(n),
              logLines: parsed.data.logLines,
              secrets: [options.token],
            }),
          );
          return;
        }
        case "asks.open": {
          const parsed = AsksOpenParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          requireHost(peer);
          const { ask, created } = await store.createAsk(parsed.data);
          if (created) {
            emit(ask.channelId, "ask.opened", {
              channelId: ask.channelId,
              ask,
            });
            /* #161: a created ask IS the needs-you transition — push. A
               replayed open returns created=false, so a host retry can't
               re-notify. Fire-and-forget: push never blocks the relay. */
            options.push
              ?.askOpened(ask)
              .catch((error) => log(`push fan-out failed: ${error}`));
          }
          respond(peer, id, { ask });
          return;
        }
        case "asks.respond": {
          const parsed = AsksRespondParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const existing = await store.getAsk(parsed.data.askId);
          if (!existing) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "ask not found",
            );
          }
          if (existing.state === "resolved") {
            throw new RpcError(
              JsonRpcCode.conflict,
              "conflict",
              "ask already resolved",
            );
          }
          // The relay doesn't interpret engine asks, but it does enforce the
          // outcome/kind pairing the engine contract declares, so a malformed
          // answer can't be stored and replayed.
          const { kind } = existing.request;
          const outcome = parsed.data.outcome;
          const valid =
            kind === "approval"
              ? outcome !== "answer"
              : kind === "plan"
                ? /* #180: a plan ask answers approve / reject / change
                     (with text) — never the question kind's "answer". */
                  outcome === "approve" ||
                  outcome === "reject" ||
                  outcome === "change" ||
                  outcome === "cancel"
                : outcome === "answer" || outcome === "cancel";
          if (!valid) {
            throw new RpcError(
              JsonRpcCode.invalidParams,
              "invalid_params",
              `outcome ${outcome} is not valid for a ${kind} ask`,
            );
          }
          if (
            (outcome === "answer" || outcome === "change") &&
            !parsed.data.answer
          ) {
            throw new RpcError(
              JsonRpcCode.invalidParams,
              "invalid_params",
              `outcome ${outcome} requires an answer`,
            );
          }
          const ask = await store.resolveAsk(existing.id, {
            outcome,
            answer: parsed.data.answer,
          });
          if (ask) {
            emit(ask.channelId, "ask.resolved", {
              channelId: ask.channelId,
              ask,
            });
          }
          respond(peer, id, { ask });
          return;
        }
        case "asks.list": {
          const parsed = AsksListParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          respond(peer, id, { asks: await store.listAsks(parsed.data) });
          return;
        }
        case "settings.get": {
          const parsed = SettingsGetParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const value = await store.getSetting(parsed.data.key);
          respond(peer, id, { value });
          return;
        }
        case "settings.set": {
          const parsed = SettingsSetParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          await store.setSetting(parsed.data.key, parsed.data.value);
          // One list for every connected client (#92 AC-7): a write by any
          // peer is broadcast so all surfaces update at once.
          broadcast("settings.changed", {
            key: parsed.data.key,
            value: parsed.data.value,
          });
          respond(peer, id, { ok: true });
          return;
        }
        case "turns.interrupt": {
          const parsed = TurnsInterruptParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          emit(conversation.channelId, "turn.interruptRequested", {
            channelId: conversation.channelId,
            conversationId: conversation.id,
          });
          respond(peer, id, { ok: true });
          return;
        }
        case "conversations.setModel": {
          const parsed = ConversationsSetModelParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          // The pick lands via the engine host (session.setModel ack → the
          // host writes conversation.model/provider/effort/fast), so the
          // relay only notifies — the whole pick rides the event (#92).
          emit(conversation.channelId, "conversation.modelRequested", {
            channelId: conversation.channelId,
            conversationId: conversation.id,
            model: parsed.data.model,
            ...(parsed.data.provider !== undefined
              ? { provider: parsed.data.provider }
              : {}),
            ...(parsed.data.effort !== undefined
              ? { effort: parsed.data.effort }
              : {}),
            ...(parsed.data.fast !== undefined
              ? { fast: parsed.data.fast }
              : {}),
          });
          respond(peer, id, { ok: true });
          return;
        }
        case "conversations.setAccess": {
          const parsed = ConversationsSetAccessParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          /* #106: the composer pill's switch is LilOS data — the row writes
             here and `conversation.updated` carries it; the host sees the
             next approval request route on the fresh value. */
          const conversation = await store.updateConversation(
            parsed.data.conversationId,
            { access: parsed.data.access },
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          emitConversation(conversation.channelId, conversation);
          respond(peer, id, { conversation });
          return;
        }
        case "session.events": {
          /* Engine-event replay scoped to one conversation (#157): the phone
             (device scope) replays the turn stream through the relay — the
             conversation's `engineRef` maps the call onto the host's
             `events.since`. No engine session bound yet = nothing to
             replay; the client treats `not_found` as an empty feed. */
          const parsed = SessionEventsParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation?.engineRef) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "no engine session bound to this conversation",
            );
          }
          forwardToHost(peer, id, "events.since", {
            sessionId: conversation.engineRef,
            after: parsed.data.after,
          });
          return;
        }
        case "conversations.prs": {
          /* A thread's pull requests (#159): conversationId-scoped like
             `session.events` — the conversation's folder + branch(es)
             resolve here so a device peer can never name a host path it
             picked itself. A just-chat thread (no folder) answers an empty
             list without a host call; host failures (not a repo, `gh`
             missing/signed out) surface as errors the app treats as "no
             PRs" (AC-4). */
          const parsed = ConversationsPrsParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          const path = conversation.cwd ?? conversation.workspace?.repoPath;
          if (!path) {
            respond(peer, id, { prs: [] });
            return;
          }
          const result = (await callHost("forge.prs", {
            path,
            ...(conversation.workspace?.branch
              ? { branches: [conversation.workspace.branch] }
              : {}),
          })) as ForgePrsResult | null;
          respond(peer, id, { prs: result?.prs ?? [] });
          return;
        }
        case "engine.event": {
          /* Host-only (#157): every engine event of a conversation-bound
             session is re-published here so channel subscribers — the
             phone — see the live turn. Unknown conversations drop silently:
             a push can land before its `conversation.updated` bind did. */
          requireHost(peer);
          const parsed = EngineEventParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (conversation) {
            emit(
              conversation.channelId,
              "engine.event",
              {
                channelId: conversation.channelId,
                conversationId: conversation.id,
                sessionId: parsed.data.sessionId,
                event: parsed.data.event,
              },
              // The host pushed it — no need to send its own stream back.
              host?.peer,
            );
            /* #300: the context meter's usage lives on the row, not the
               stream — persist each turn.completed's usage so it survives
               replay failure entirely. Best-effort like the push fan-out:
               a persist hiccup must not drop the event's ack. */
            const usage =
              parsed.data.event.type === "turn.completed"
                ? parsed.data.event.payload.usage
                : undefined;
            if (usage) {
              store
                .recordTurnUsage({
                  conversationId: conversation.id,
                  sessionId: parsed.data.sessionId,
                  seq: parsed.data.event.seq,
                  usage,
                })
                .catch((error) => log(`usage persist failed: ${error}`));
            }
            /* #161: turn.completed / session.state-error transitions push;
               the fan-out's seq watermark drops replays. */
            options.push
              ?.engineEvent(
                conversation,
                parsed.data.sessionId,
                parsed.data.event,
              )
              .catch((error) => log(`push fan-out failed: ${error}`));
          }
          respond(peer, id, { ok: true });
          return;
        }
        /* ---------------- workbench open (#340) ---------------- */
        case "workbench.open": {
          /* The agent's `workbench_open` tool: show the user a file/diff/PR/
             url inside the app's Workbench. Host-only (the agent's voice),
             fan-out as a channel event — never a synthesized EngineEvent,
             whose seq would poison `events.since` replay + push watermarks. */
          requireHost(peer);
          const parsed = WorkbenchOpenParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const conversation = await store.getConversation(
            parsed.data.conversationId,
          );
          if (!conversation) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "conversation not found",
            );
          }
          emit(
            conversation.channelId,
            "workbench.opened",
            {
              channelId: conversation.channelId,
              conversationId: conversation.id,
              target: parsed.data.target,
            },
            host?.peer,
          );
          respond(peer, id, { ok: true });
          return;
        }
        /* ---------------- phone pairing (#153) ---------------- */
        case "pairing.offer": {
          /**
           * The dialog's "turn on phone access": binds the Tailscale listener
           * (opt-in — loopback never appears in a QR) and mints a fresh
           * one-time grant for the code/QR it renders.
           */
          if (!options.pairing) {
            throw new RpcError(
              JsonRpcCode.unavailable,
              "internal",
              "pairing is not configured",
            );
          }
          const bound = await options.phoneAccess?.enable();
          if (!bound) {
            throw new RpcError(
              JsonRpcCode.unavailable,
              "tailscale_unavailable",
              "Tailscale isn't running on this Mac — install it and sign in, then try again.",
            );
          }
          const grant = await options.pairing.mintGrant();
          const profile = await store.getProfile();
          const name = profile.userName
            ? `${profile.userName}'s Mac`
            : (options.macName ?? "this Mac");
          respond(peer, id, {
            offer: {
              host: bound.host,
              code: grant.code,
              name,
              expiresAt: grant.expiresAt,
            },
          });
          return;
        }
        case "pairing.disable": {
          await options.phoneAccess?.disable();
          respond(peer, id, { ok: true });
          return;
        }
        case "devices.list": {
          respond(peer, id, {
            devices: (await options.pairing?.listDevices()) ?? [],
          });
          return;
        }
        case "devices.revoke": {
          const parsed = DevicesRevokeParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const device = await options.pairing?.revokeDevice(
            parsed.data.deviceId,
          );
          if (!device) {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "device not found",
            );
          }
          // Drop the revoked phone's live sockets; `closed()` then cleans
          // devicePeers/helloedPeers/subscriptions for each.
          for (const [p, did] of devicePeers) {
            if (did === device.id)
              p.close(WS_CLOSE_DEVICE_REVOKED, "device revoked");
          }
          /* #161 AC-1: revoke drops the push token too — the store cascade
             deletes the row; the fan-out forgets its visibility report. */
          options.push?.deviceGone(device.id);
          respond(peer, id, { ok: true });
          return;
        }
        /* ---------------- push registration (#161) ---------------- */
        case "push.register": {
          /* The phone reports its Expo push token + per-kind toggles, tied
             to the deviceId its hello authenticated. Idempotent upsert —
             sent after pairing and on every foreground. */
          const deviceId = requireDevice(peer);
          const parsed = PushRegisterParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          await store.setDevicePush({
            deviceId,
            token: parsed.data.token,
            prefs: parsed.data.prefs,
            at: now(),
          });
          respond(peer, id, { ok: true });
          return;
        }
        case "push.unregister": {
          const deviceId = requireDevice(peer);
          const parsed = PushUnregisterParams.safeParse(params ?? {});
          if (!parsed.success) throw badParams(parsed.error.issues);
          await store.dropDevicePush(deviceId);
          options.push?.deviceGone(deviceId);
          respond(peer, id, { ok: true });
          return;
        }
        case "push.visibility": {
          /* Which thread this phone has open right now — the suppression
             input (AC-5). In-memory on the fan-out: a dead socket clears it
             in `closed()`, so a stale report can't mute pushes forever. */
          const deviceId = requireDevice(peer);
          const parsed = PushVisibilityParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          options.push?.setVisibility(deviceId, parsed.data.conversationId);
          respond(peer, id, { ok: true });
          return;
        }
        default:
          throw new RpcError(
            JsonRpcCode.methodNotFound,
            "internal",
            `unknown method ${method}`,
          );
      }
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
