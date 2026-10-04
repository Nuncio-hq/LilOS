import type {
  AttachmentInput,
  JsonRpcRequest,
  MessageAttachment,
} from "@lilos/contracts/app";
import type { AttachmentStore } from "../attachments";
import type { LogTail } from "../logtail";
import type { RelayOptions, RelayWsPeer } from "../session";
import type { RejectedHandshake } from "../status";
import type { RelayStore } from "../store";
import type { HostRecord } from "./rpc";

/**
 * The shared half of the per-request ctx the moved handle() case bodies
 * close over (#441): every value/function `handle()`'s switch used, carried
 * verbatim onto one object. `host` and `lastHostDisconnectedAt` are
 * accessor-backed so live reads and the harness.register write-back land on
 * createRelay's closure lets.
 */
export interface RelaySharedCtx {
  options: RelayOptions;
  store: RelayStore;
  protocolVersion: number;
  relayVersion: string;
  maxReplay: number;
  snapshotLimit: number;
  instanceId: string;
  subscribers: Map<string, Set<RelayWsPeer>>;
  helloedPeers: Set<RelayWsPeer>;
  devicePeers: Map<RelayWsPeer, string>;
  now: () => number;
  homeDir: string;
  heartbeatFreshMs: number;
  logTail: LogTail;
  log: (message: string) => void;
  attachmentStore: AttachmentStore;
  storeAttachments: (
    inputs: AttachmentInput[] | undefined,
  ) => Promise<MessageAttachment[] | undefined>;
  dropAttachments: (refs: MessageAttachment[] | undefined) => void;
  rejectedHandshakes: RejectedHandshake[];
  emit: (
    channelId: string,
    method: string,
    params: unknown,
    except?: RelayWsPeer,
  ) => void;
  broadcast: (method: string, params: unknown) => void;
  emitMessage: (channelId: string, message: unknown) => void;
  emitMessageChanged: (
    channelId: string,
    message: unknown,
    flags?: string[],
  ) => void;
  emitConversation: (channelId: string, conversation: unknown) => void;
  isHost: (peer: RelayWsPeer) => boolean;
  requireHost: (peer: RelayWsPeer) => void;
  requireDevice: (peer: RelayWsPeer) => string;
  recordRejection: (rejection: RejectedHandshake) => void;
  forwardToHost: (
    caller: RelayWsPeer,
    callerId: JsonRpcRequest["id"],
    method: string,
    params: unknown,
  ) => void;
  callHost: (
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
  respond: (
    peer: RelayWsPeer,
    id: JsonRpcRequest["id"],
    result: unknown,
  ) => void;
  host: HostRecord | null;
  lastHostDisconnectedAt: number | undefined;
}

/** Per-request view: the shared ctx plus the fields that differ per call. */
export interface RelayCtx extends RelaySharedCtx {
  peer: RelayWsPeer;
  state: { helloed: boolean; subscriptions: Set<string> };
  id: JsonRpcRequest["id"];
  method: string;
  params: unknown;
}
