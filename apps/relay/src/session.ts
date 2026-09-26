import { randomUUID } from "node:crypto";
import {
  APP_PROTOCOL_VERSION,
  type AppErrorCode,
  ChannelSubscribeParams,
  ChannelsOpenDmParams,
  ChannelUnsubscribeParams,
  ConversationsListParams,
  ConversationsOpenParams,
  ConversationsUpdateParams,
  EmployeesCreateParams,
  EmployeesUpdateParams,
  HelloParams,
  type JsonRpcRequest,
  MessagesListParams,
  MessagesPostParams,
  type WelcomeResult,
} from "@lilos/contracts/app";
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
  protocolVersion?: number;
  relayVersion?: string;
  /** Replay cap on subscribe: a gap larger than this falls back to a snapshot. */
  maxReplay?: number;
  /** Snapshot window when the client has no usable cursor. */
  snapshotLimit?: number;
}

export interface RelayConnection {
  receive(data: string): Promise<void>;
  closed(): void;
}

export interface Relay {
  instanceId: string;
  connect(peer: RelayWsPeer): RelayConnection;
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
  notFound: -32004,
} as const;

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

  const emit = (channelId: string, method: string, params: unknown) => {
    const peers = subscribers.get(channelId);
    if (!peers) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const peer of peers) peer.send(frame);
  };

  const emitMessage = (channelId: string, message: unknown) =>
    emit(channelId, "message.created", { channelId, message });

  const emitConversation = (channelId: string, conversation: unknown) =>
    emit(channelId, "conversation.updated", { channelId, conversation });

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
      switch (method) {
        case "session.hello": {
          const parsed = HelloParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const hello = parsed.data;
          if (hello.token !== options.token) {
            throw new RpcError(
              JsonRpcCode.unauthenticated,
              "unauthenticated",
              "bad auth token",
            );
          }
          if (hello.protocolVersion !== protocolVersion) {
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
          const welcome: WelcomeResult = {
            protocolVersion,
            relayVersion,
            instanceId,
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
          respond(peer, id, {
            employee: await store.createEmployee(parsed.data),
          });
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
          respond(peer, id, { employee });
          return;
        }
        case "channels.list": {
          respond(peer, id, { channels: await store.listChannels() });
          return;
        }
        case "channels.openDm": {
          const parsed = ChannelsOpenDmParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
          const channel = await store.openDmChannel(parsed.data.employeeId);
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
          const { conversation, rootMessage } = await store.openConversation(
            parsed.data,
          );
          emitMessage(conversation.channelId, rootMessage);
          emitConversation(conversation.channelId, conversation);
          respond(peer, id, { conversation, rootMessage });
          return;
        }
        case "conversations.update": {
          const parsed = ConversationsUpdateParams.safeParse(params);
          if (!parsed.success) throw badParams(parsed.error.issues);
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
          try {
            const message = await store.appendMessage(parsed.data);
            emitMessage(message.channelId, message);
            respond(peer, id, { message });
          } catch {
            throw new RpcError(
              JsonRpcCode.notFound,
              "not_found",
              "channel or conversation not found",
            );
          }
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
        },
      };
    },
  };
}
