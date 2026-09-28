import { randomUUID } from "node:crypto";
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
  ConversationsSetModelParams,
  ConversationsSummariesParams,
  ConversationsUpdateParams,
  EmployeesCreateParams,
  EmployeesRemoveParams,
  EmployeesUpdateParams,
  ENGINE_PASSTHROUGH_METHODS,
  ENGINE_PASSTHROUGH_PARAMS,
  type EngineHostState,
  type EnginePassthroughMethod,
  FoldersAddParams,
  FoldersListParams,
  HarnessRegisterParams,
  HarnessReportParams,
  type HarnessStatusReport,
  HelloParams,
  type JsonRpcRequest,
  MAX_ATTACHMENT_BYTES,
  type MessageAttachment,
  MessagesListParams,
  MessagesPostParams,
  MessagesSearchParams,
  ProfileUpdateParams,
  SettingsGetParams,
  SettingsSetParams,
  SystemStatusParams,
  TurnsInterruptParams,
  type WelcomeResult,
} from "@lilos/contracts/app";
import {
  type AttachmentStore,
  createMemoryAttachmentStore,
} from "./attachments";
import { createLogTail, type LogTail } from "./logtail";
import { buildSystemStatus, type RejectedHandshake } from "./status";
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
}

export interface RelayConnection {
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
  const now = options.now ?? (() => Date.now());
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

  /** In-flight `agents.*`/`models.*` calls forwarded to the engine host. */
  const hostCalls = new Map<
    string,
    {
      caller: RelayWsPeer;
      callerId: JsonRpcRequest["id"];
      hostPeer: RelayWsPeer;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let hostCallSeq = 0;
  const hostCallTimeoutMs = options.hostCallTimeoutMs ?? 15_000;

  const emit = (channelId: string, method: string, params: unknown) => {
    const peers = subscribers.get(channelId);
    if (!peers) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const peer of peers) peer.send(frame);
  };

  /** To every helloed peer — used for `channel.created`. */
  const broadcast = (method: string, params: unknown) => {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const peer of helloedPeers) peer.send(frame);
  };

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

  const emitMessage = (channelId: string, message: unknown) =>
    emit(channelId, "message.created", { channelId, message });

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
      respondError(
        call.caller,
        call.callerId,
        numeric,
        numeric === JsonRpcCode.unavailable
          ? "engine_unavailable"
          : "engine_error",
        typeof error.message === "string"
          ? error.message
          : "engine call failed",
        { engine: error.data },
      );
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
          const parsed = HelloParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const hello = parsed.data;
          if (hello.token !== options.token) {
            log("session.hello rejected: bad token");
            throw new RpcError(
              JsonRpcCode.unauthenticated,
              "unauthenticated",
              "bad auth token",
            );
          }
          if (hello.protocolVersion !== protocolVersion) {
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
          respond(peer, id, {
            folder: await store.addRecentFolder(parsed.data.path),
          });
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
          try {
            const { conversation, rootMessage } = await store.openConversation({
              ...parsed.data,
              attachments,
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
          const { conversationId, ...patch } = parsed.data;
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
        case "messages.list": {
          const parsed = MessagesListParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          try {
            const page = await store.listMessages(parsed.data.channelId, {
              conversationId: parsed.data.conversationId,
              afterSeq: parsed.data.afterSeq,
              limit: parsed.data.limit,
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
            if (created) emitMessage(message.channelId, message);
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
            if (parsed.data.status) host.status = parsed.data.status;
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
              : outcome === "answer" || outcome === "cancel";
          if (!valid) {
            throw new RpcError(
              JsonRpcCode.invalidParams,
              "invalid_params",
              `outcome ${outcome} is not valid for a ${kind} ask`,
            );
          }
          if (outcome === "answer" && !parsed.data.answer) {
            throw new RpcError(
              JsonRpcCode.invalidParams,
              "invalid_params",
              "outcome answer requires an answer",
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
              respondError(
                call.caller,
                call.callerId,
                JsonRpcCode.unavailable,
                "engine_unavailable",
                "engine host disconnected",
              );
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
