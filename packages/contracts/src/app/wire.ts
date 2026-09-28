import { z } from "zod";
import {
  AgentsCreateParams,
  AgentsDescribeParams,
  AgentsListParams,
} from "../engine/agents";
import { Capability } from "../engine/capabilities";
import { ModelOption, ModelProvider, ModelsListParams } from "../engine/models";
import { ApprovalOutcome, EngineRequest } from "../engine/requests";
import {
  AppChannel,
  AppMessage,
  Ask,
  AskState,
  AuthorKind,
  Conversation,
  ConversationState,
  ConversationSummary,
  Employee,
  EmployeeStatus,
  EngineHostStatus,
  MessageAttachment,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  RecentFolder,
  RespondTo,
  Timestamp,
} from "./domain";
import { APP_PROTOCOL_VERSION } from "./version";

/**
 * Wire framing: JSON-RPC 2.0 over one WebSocket endpoint (`/ws`), the same
 * shape the reference desktop app (AGENTS.md "Learn from these projects")
 * uses between renderer and engine
 * (`apps/shared/src/json-rpc-gateway.ts`). The first frame on a socket must
 * be a `session.hello` request carrying the protocol version and the
 * per-install auth token; every other method is rejected until hello
 * succeeds.
 */

export const RequestId = z.union([z.string().min(1), z.int()]);
export type RequestId = z.infer<typeof RequestId>;

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestId,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

/** Codes carried in `error.data.code` (JSON-RPC `error.code` stays numeric). */
export const AppErrorCode = z.enum([
  "unauthenticated",
  "protocol_version_mismatch",
  "invalid_params",
  "not_found",
  "forbidden",
  "conflict",
  "engine_unavailable",
  "engine_error",
  "attachment_too_large",
  /** Pairing asked for the Tailscale listener but Tailscale is down/missing. */
  "tailscale_unavailable",
  "internal",
]);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/** `error.data` for `protocol_version_mismatch`: names the stale side. */
export const ProtocolVersionMismatch = z.object({
  code: z.literal("protocol_version_mismatch"),
  /** Which side is older and must be updated. */
  update: z.enum(["client", "server"]),
  clientVersion: z.int(),
  serverVersion: z.int(),
});
export type ProtocolVersionMismatch = z.infer<typeof ProtocolVersionMismatch>;

export const RpcError = z.object({
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const JsonRpcResponse = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, error: RpcError }),
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** Any frame on the app socket. */
export const AppFrame = z.union([
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
]);
export type AppFrame = z.infer<typeof AppFrame>;

/* ------------------------------- methods ------------------------------- */

export const AppMethod = z.enum([
  "session.hello",
  "employees.list",
  "employees.create",
  "employees.update",
  "channels.list",
  "channels.openDm",
  "conversations.list",
  "conversations.summaries",
  "conversations.open",
  "conversations.update",
  "messages.list",
  "messages.post",
  "attachments.get",
  "channel.subscribe",
  "channel.unsubscribe",
  "harness.register",
  "harness.report",
  "asks.open",
  "asks.respond",
  "asks.list",
  "turns.interrupt",
  "conversations.setModel",
  "system.status",
  "employees.remove",
  /* LilOS-owned client settings (engine keeps no such state): a generic KV
     store — model visibility picks, UI prefs the app wants shared across
     surfaces and restarts. */
  "settings.get",
  "settings.set",
  /* LilOS-owned recent folders for the session folder picker (#113) */
  "folders.list",
  "folders.add",
  /* The signed-in human's identity — name, company, avatar colour (#118).
     `settings.*` is #92's KV namespace, so the profile uses `profile.*`. */
  "profile.get",
  "profile.update",
  /* engine passthrough: forwarded verbatim to the registered engine host */
  "agents.list",
  "agents.describe",
  "agents.create",
  "models.list",
  /* Phone pairing (#153): minting a grant is the opt-in that also binds the
     Tailscale listener; devices.list/revoke manage what the grant exchange
     created. `pairing.disable` turns phone access off again. */
  "pairing.offer",
  "pairing.disable",
  "devices.list",
  "devices.revoke",
]);
export type AppMethod = z.infer<typeof AppMethod>;

/**
 * Engine-protocol methods the relay forwards verbatim to the registered
 * engine host (`harness.register`) as a JSON-RPC request and relays the
 * response back — the app never opens an engine socket. The params schemas
 * are the engine's own, re-used here so the relay validates before
 * forwarding. No host, a host disconnect, or a host-side timeout answers
 * `engine_unavailable`; an engine-side error answer surfaces `engine_error`.
 */
export const ENGINE_PASSTHROUGH_METHODS = [
  "agents.list",
  "agents.describe",
  "agents.create",
  "models.list",
] as const;
export type EnginePassthroughMethod =
  (typeof ENGINE_PASSTHROUGH_METHODS)[number];

/** Params schema per passthrough method, for the relay's validate-then-forward gate. */
export const ENGINE_PASSTHROUGH_PARAMS = {
  "agents.list": AgentsListParams,
  "agents.describe": AgentsDescribeParams,
  "agents.create": AgentsCreateParams,
  "models.list": ModelsListParams,
} as const satisfies Record<EnginePassthroughMethod, z.ZodType>;

const HelloClient = z
  .object({ name: z.string().optional(), version: z.string().optional() })
  .optional();

/**
 * The opening handshake, in two credential shapes (#153):
 * - `token`: the per-install token — what local clients (app, harness) send.
 * - `deviceId` + `credential`: a paired phone's own credential, minted by
 *   `POST /pair/exchange`; revocable per device without rotating the install
 *   token. Strict on both variants so a frame can't mix the two.
 */
export const HelloParams = z.union([
  z.strictObject({
    protocolVersion: z.int().min(1),
    /** Per-install token generated by the relay on first run. */
    token: z.string().min(1),
    client: HelloClient,
  }),
  z.strictObject({
    protocolVersion: z.int().min(1),
    deviceId: z.string().min(1),
    credential: z.string().min(1),
    client: HelloClient,
  }),
]);
export type HelloParams = z.infer<typeof HelloParams>;

export const WelcomeResult = z.object({
  protocolVersion: z.int(),
  relayVersion: z.string(),
  /**
   * Process identity of this relay run (`replay_epoch` analog in the reference gateway). A
   * change across reconnects tells the client its seq watermarks describe a
   * numbering that may no longer exist — it must resync from a snapshot.
   */
  instanceId: z.string().min(1),
  /** Engine host presence, so a client can show it without a second round trip. */
  engineHost: EngineHostStatus.optional(),
});
export type WelcomeResult = z.infer<typeof WelcomeResult>;

export const EmployeesListParams = z.object({}).strict();
export const EmployeesListResult = z.object({ employees: z.array(Employee) });

export const EmployeePatch = z.object({
  name: z.string().min(1).optional(),
  role: z.string().optional(),
  status: EmployeeStatus.optional(),
  profile: z.string().optional(),
  model: z.string().optional(),
  now: z.string().optional(),
  instructions: z.string().optional(),
  respondTo: RespondTo.optional(),
});
export type EmployeePatch = z.infer<typeof EmployeePatch>;

export const EmployeesCreateParams = z.object({
  name: z.string().min(1),
  role: z.string().default(""),
  status: EmployeeStatus.default("offline"),
  profile: z.string().default(""),
  model: z.string().default(""),
  now: z.string().default(""),
  instructions: z.string().default(""),
  respondTo: RespondTo.default("me"),
});
export type EmployeesCreateParams = z.infer<typeof EmployeesCreateParams>;
/** Caller-facing shape: `.default()` fields are optional on the wire. */
export type EmployeesCreateParamsInput = z.input<typeof EmployeesCreateParams>;

export const EmployeesUpdateParams = z.object({
  id: z.string().min(1),
  ...EmployeePatch.shape,
});
export type EmployeesUpdateParams = z.infer<typeof EmployeesUpdateParams>;

/**
 * Remove deletes only the LilOS record (employee + its DM channel,
 * conversations, messages, asks). The linked engine profile is never
 * touched — engines own profiles; there is no profile-delete call anywhere.
 */
export const EmployeesRemoveParams = z.object({ id: z.string().min(1) });
export type EmployeesRemoveParams = z.infer<typeof EmployeesRemoveParams>;

export const EmployeeResult = z.object({ employee: Employee });

export const ChannelsListParams = z.object({}).strict();
export const ChannelsListResult = z.object({ channels: z.array(AppChannel) });

/** Get-or-create the DM channel with one employee. */
export const ChannelsOpenDmParams = z.object({ employeeId: z.string().min(1) });
export type ChannelsOpenDmParams = z.infer<typeof ChannelsOpenDmParams>;
export const ChannelResult = z.object({ channel: AppChannel });

/* --------------------------- attachments (#31) --------------------------- */

/** Largest single attachment the relay stores, in decoded bytes. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Most attachments one message can carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * A file the client uploads inline with a message. Scope is images only
 * (#31) — other mime types are `invalid_params`, an oversized decoded body
 * is the typed `attachment_too_large`. The relay stores the blob and puts
 * only display refs on the message; bytes come back via `attachments.get`.
 */
export const AttachmentInput = z.object({
  name: z.string().default(""),
  mimeType: z.string().regex(/^image\//),
  /** Base64-encoded bytes. */
  dataBase64: z.string().min(1),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

const AttachmentsField = z
  .array(AttachmentInput)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .optional();

export const ConversationsListParams = z.object({
  channelId: z.string().min(1).optional(),
  includeArchived: z.boolean().default(false),
});
export type ConversationsListParams = z.infer<typeof ConversationsListParams>;
export const ConversationsListResult = z.object({
  conversations: z.array(Conversation),
});

/**
 * Session-list read: one row per conversation carrying the messages the row
 * renders, so the list survives the channel's snapshot window. Results order
 * follows `conversations.list` (createdAt asc).
 */
export const ConversationsSummariesParams = z.object({
  channelId: z.string().min(1).optional(),
  includeArchived: z.boolean().default(false),
});
export type ConversationsSummariesParams = z.infer<
  typeof ConversationsSummariesParams
>;
export const ConversationsSummariesResult = z.object({
  summaries: z.array(ConversationSummary),
});

/**
 * Opens a thread in a channel with its root message; the returned
 * conversation is `idle` until the harness attaches `engineRef`. An
 * image-only send (#112: attachment chips with no typed text) opens one too,
 * so the text may be empty only when `attachments` carry it.
 */
export const ConversationsOpenParams = z
  .object({
    channelId: z.string().min(1),
    text: z.string(),
    title: z.string().default(""),
    authorId: z.string().min(1).default("user"),
    attachments: AttachmentsField,
    /** The user's pick made in the composer before the first send (#92): stamped
        on the conversation so the harness applies it at `session.start` — no
        post-open `setModel` race. */
    model: z.string().min(1).optional(),
    provider: z.string().optional(),
    effort: z.string().optional(),
    fast: z.boolean().optional(),
    /** Folder the session works in (#113); absent = harness default workdir. */
    cwd: z.string().min(1).optional(),
  })
  .refine(
    (p) => p.text.length > 0 || (p.attachments?.length ?? 0) > 0,
    "conversations.open needs text or at least one attachment",
  );
export type ConversationsOpenParams = z.infer<typeof ConversationsOpenParams>;
export const ConversationsOpenResult = z.object({
  conversation: Conversation,
  rootMessage: AppMessage,
});

/**
 * Update a conversation: `title`/`archived` by any client; `state`,
 * `engineRef` and the `deliveredSeq` watermark are host-only writes.
 */
export const ConversationsUpdateParams = z.object({
  conversationId: z.string().min(1),
  title: z.string().optional(),
  archived: z.boolean().optional(),
  state: ConversationState.optional(),
  engineRef: z.string().min(1).optional(),
  /** Host-only: the pick the engine acked / will apply at session.start.
      `null` clears a field the new pick dropped (e.g. a model with no
      effort/fast control) or a failed pick restore (#92). */
  model: z.string().min(1).nullable().optional(),
  provider: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fast: z.boolean().nullable().optional(),
  deliveredSeq: z.int().min(0).optional(),
});
export type ConversationsUpdateParams = z.infer<
  typeof ConversationsUpdateParams
>;
export const ConversationResult = z.object({ conversation: Conversation });

/**
 * History read. Without `afterSeq` returns the channel's messages (the last
 * `limit` when `limit` is set); with `afterSeq` returns the first `limit`
 * messages with `seq > afterSeq` — the same range replay pushes on resubscribe.
 */
export const MessagesListParams = z.object({
  channelId: z.string().min(1),
  /** Restrict to one thread — full thread history regardless of the snapshot window. */
  conversationId: z.string().min(1).optional(),
  afterSeq: z.int().min(0).optional(),
  limit: z.int().min(1).optional(),
});
export type MessagesListParams = z.infer<typeof MessagesListParams>;
export const MessagesListResult = z.object({
  messages: z.array(AppMessage),
  lastSeq: z.int().min(0),
});

export const MessagesPostParams = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  text: z.string(),
  authorId: z.string().min(1).default("user"),
  authorKind: AuthorKind.default("user"),
  attachments: AttachmentsField,
  /** Engine `turn.started.model` — set by the host on employee answers. */
  model: z.string().min(1).optional(),
  /** The rest of the turn's pick (`turn.started.provider/effort/fast`). */
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  /**
   * Exactly-once key for retried writes: a re-post with a key the channel
   * already recorded returns the original message instead of duplicating it
   * (no `message.created` re-emitted either).
   */
  dedupeKey: z.string().min(1).max(200).optional(),
});
export type MessagesPostParams = z.infer<typeof MessagesPostParams>;
export const MessageResult = z.object({ message: AppMessage });

/**
 * Resumable subscription (T3 Code `afterSequence` pattern, see
 * `docs/internals` + `apps/server/src/ws.ts`): without `afterSeq` the relay
 * sends a `channel.snapshot` notification; with it, the relay replays every
 * `message.created` newer than the cursor. A cursor ahead of the channel's
 * `lastSeq` is invalid and falls back to a snapshot. A `channel.synced`
 * notification always terminates the catch-up window and precedes live events.
 */
export const ChannelSubscribeParams = z.object({
  channelId: z.string().min(1),
  afterSeq: z.int().min(0).optional(),
});
export type ChannelSubscribeParams = z.infer<typeof ChannelSubscribeParams>;
export const ChannelSubscribeResult = z.object({
  channelId: z.string().min(1),
  lastSeq: z.int().min(0),
});

export const ChannelUnsubscribeParams = z.object({
  channelId: z.string().min(1),
});
export const OkResult = z.object({ ok: z.literal(true) });

/**
 * Recent folders (#113): `folders.list` returns the shared list newest-first;
 * `folders.add` records a pick (a `conversations.open` with `cwd` bumps it
 * the same way). Not scoped to an employee — one company, one recents list.
 */
export const FoldersListParams = z.object({}).strict();
export const FoldersListResult = z.object({
  folders: z.array(RecentFolder),
});
export const FoldersAddParams = z.object({ path: z.string().min(1) });
export const FoldersAddResult = z.object({ folder: RecentFolder });

/**
 * Profile settings (#118): `profile.get` returns the stored profile — `{}`
 * on an untouched install, the app prefills from the OS (AC-4).
 * `profile.update` merges the given keys and returns the stored profile.
 * (`settings.*` belongs to #92's generic KV namespace.)
 */
export const ProfileGetParams = z.object({}).strict();
export const ProfileGetResult = z.object({ profile: ProfileSettings });
export const ProfileUpdateParams = ProfileSettings.refine(
  (p) => Object.values(p).some((v) => v !== undefined),
  { message: "at least one setting required" },
);
export type ProfileUpdateParams = z.infer<typeof ProfileUpdateParams>;
export const ProfileUpdateResult = z.object({ profile: ProfileSettings });

/** Fetch one stored attachment's bytes — the read path behind display refs. */
export const AttachmentsGetParams = z.object({
  id: z.string().min(1),
});
export type AttachmentsGetParams = z.infer<typeof AttachmentsGetParams>;
export const AttachmentsGetResult = z.object({
  attachment: MessageAttachment,
  /** The stored bytes, base64. */
  dataBase64: z.string(),
});
export type AttachmentsGetResult = z.infer<typeof AttachmentsGetResult>;

/* ------------------------- system status (#33) ------------------------- */

/** The chain a session needs, mirrored by the status UI's row ids. */
export const StatusComponentId = z.enum([
  "relay",
  "harness",
  "engine",
  "model",
]);
export type StatusComponentId = z.infer<typeof StatusComponentId>;

export const StatusComponentState = z.enum([
  "ok",
  "connecting",
  "degraded",
  /** Down only because an upstream leg is down — waiting, not broken (#53). */
  "blocked",
  "down",
]);
export type StatusComponentState = z.infer<typeof StatusComponentState>;

/** One row of the status surface: what is checked and why it is not ok. */
export const StatusComponent = z.object({
  id: StatusComponentId,
  label: z.string().min(1),
  state: StatusComponentState,
  reason: z.string(),
});
export type StatusComponent = z.infer<typeof StatusComponent>;

/** A protocol-version gap the user can act on — names which side to update. */
export const StatusMismatch = z.object({
  update: z.enum(["app", "relay", "harness"]),
  detail: z.string().min(1),
});
export type StatusMismatch = z.infer<typeof StatusMismatch>;

export const SystemStatusParams = z
  .object({
    /** Log lines per component to include under `logs`; 0 = none. */
    logLines: z.int().min(0).max(200).default(0),
  })
  .strict();
export type SystemStatusParams = z.infer<typeof SystemStatusParams>;

/**
 * `system.status` — the one health call on the app protocol. The relay
 * aggregates what it can prove itself (its own socket + the registered host's
 * reports) instead of one endpoint per component. Log lines, when requested,
 * are redacted of tokens/secrets before they leave the relay.
 */
export const SystemStatusResult = z.object({
  protocolVersion: z.int(),
  generatedAt: Timestamp,
  /** relay, harness, engine, model — in that order. */
  components: z.array(StatusComponent),
  versions: z.object({
    relay: z.string(),
    harness: z.string().optional(),
    relayProtocol: z.int(),
    harnessProtocol: z.int().optional(),
  }),
  engine: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      rssBytes: z.int().min(0).optional(),
      sessions: z.int().min(0).optional(),
      /** What the engine advertises — the picker's model set (issue #30). */
      capabilities: z.array(Capability).optional(),
      models: z.array(ModelOption).optional(),
      defaultModel: z.string().optional(),
      /** Provider the engine's default model id belongs to (#92). */
      defaultProvider: z.string().optional(),
    })
    .optional(),
  mismatch: StatusMismatch.optional(),
  logs: z
    .object({
      relay: z.array(z.string()),
      harness: z.array(z.string()),
    })
    .optional(),
});
export type SystemStatusResult = z.infer<typeof SystemStatusResult>;

/* ------------------------- harness + asks (#26) ------------------------- */

/**
 * Registers the calling connection as the engine host. The host is the only
 * writer allowed to attach `engineRef`/`state` on conversations, post
 * non-`user` messages, and open asks. A second concurrent registration is
 * refused with `conflict` — the relay has exactly one engine host. The result
 * returns `pending`: conversations whose newest message is a user message
 * (turns the engine still owes), so a restarted host catches up.
 */
/**
 * Registers the calling connection as the engine host. Same version handshake
 * as `session.hello` (issue #33): a `protocolVersion` that differs from the
 * relay's fails with `protocol_version_mismatch` naming the stale side, so a
 * mismatched harness never registers half-spoken.
 */
export const HarnessRegisterParams = z
  .object({
    protocolVersion: z.int().min(1),
    /** Harness build version — shown in status + diagnostics. */
    version: z.string().min(1).default("0.0.0"),
  })
  .strict();
export const HarnessRegisterResult = z.object({
  hostId: z.string().min(1),
  pending: z.array(PendingTurn),
});

/**
 * Telemetry the engine host can attach to `harness.report` (issue #33): all
 * optional so a heartbeat-only report stays valid. The relay re-redacts
 * `logTail` before serving it — the harness is not the redaction boundary.
 */
export const HarnessStatusReport = z.object({
  harnessVersion: z.string().optional(),
  /** Engine identity from its `describe` handshake. */
  engineName: z.string().optional(),
  engineVersion: z.string().optional(),
  engineProtocol: z.int().optional(),
  /** Model the harness will launch sessions with. */
  model: z.string().optional(),
  /**
   * The engine's `describe` capabilities + `models.list` answer, verbatim
   * (issue #30): the relay serves them on `welcome.engineHost` so clients
   * render the picker only when the `models` capability is declared.
   */
  capabilities: z.array(Capability).optional(),
  models: z.array(ModelOption).optional(),
  /** Provider rows from the same `models.list` (group headers in the picker). */
  providers: z.array(ModelProvider).optional(),
  /** The engine's default model id (`models.list.default`) and its provider. */
  defaultModel: z.string().optional(),
  defaultProvider: z.string().optional(),
  /** RSS of the supervised engine process, bytes. */
  engineRssBytes: z.int().min(0).optional(),
  /** Sessions the harness believes are live. */
  sessions: z.int().min(0).optional(),
  /** ms epoch of the last successful engine probe. */
  probedAt: Timestamp.optional(),
  /** Recent harness log lines (newest last). */
  logTail: z.array(z.string()).max(200).optional(),
});
export type HarnessStatusReport = z.infer<typeof HarnessStatusReport>;

/** Host-only heartbeat of supervised engine state + optional status telemetry. */
export const HarnessReportParams = z.object({
  engine: z.object({
    state: z.enum(["starting", "running", "restarting", "failed", "stopped"]),
    detail: z.string().optional(),
  }),
  status: HarnessStatusReport.optional(),
});

/** Host-only: surface an engine `request.opened` to the user. */
export const AsksOpenParams = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  requestId: z.string().min(1),
  request: EngineRequest,
});
export type AsksOpenParams = z.infer<typeof AsksOpenParams>;
export const AskResult = z.object({ ask: Ask });

export const AsksRespondParams = z.object({
  askId: z.string().min(1),
  outcome: ApprovalOutcome,
  answer: z.string().optional(),
});
export type AsksRespondParams = z.infer<typeof AsksRespondParams>;

export const AsksListParams = z.object({
  channelId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  state: AskState.optional(),
});
export type AsksListParams = z.infer<typeof AsksListParams>;
export const AsksListResult = z.object({ asks: z.array(Ask) });

/** Any client: request an interrupt of the conversation's running turn. */
export const TurnsInterruptParams = z.object({
  conversationId: z.string().min(1),
});
export type TurnsInterruptParams = z.infer<typeof TurnsInterruptParams>;

/**
 * Any client: pin the model for the conversation's next turn (issue #30).
 * The relay does NOT store it here — it emits `conversation.modelRequested`
 * so the registered engine host can run `session.setModel`; the host writes
 * the acked id onto the conversation via `conversations.update`.
 */
export const ConversationsSetModelParams = z
  .object({
    conversationId: z.string().min(1),
    /** Model id from the engine's `models.list` answer (opaque; may
        contain `/` — it is never split into a `provider/model` string). */
    model: z.string().min(1),
    /** Provider slug when the model list grouped it under one. */
    provider: z.string().optional(),
    /** Reasoning-effort level the picker chose (from `ModelOption.efforts`). */
    effort: z.string().optional(),
    /** Fast/priority tier toggle. */
    fast: z.boolean().optional(),
  })
  .strict();
export type ConversationsSetModelParams = z.infer<
  typeof ConversationsSetModelParams
>;

/* -------------------------------- events ------------------------------- */

export const AppEventMethod = z.enum([
  "message.created",
  "channel.snapshot",
  "channel.synced",
  "conversation.updated",
  "channel.created",
  "ask.opened",
  "ask.resolved",
  "turn.interruptRequested",
  "channel.removed",
  "employee.upserted",
  "employee.removed",
  "conversation.modelRequested",
  "profile.updated",
  "settings.changed",
  "devices.changed",
]);
export type AppEventMethod = z.infer<typeof AppEventMethod>;

export const MessageCreatedEvent = z.object({
  channelId: z.string().min(1),
  message: AppMessage,
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEvent>;

export const ChannelSnapshotEvent = z.object({
  channelId: z.string().min(1),
  messages: z.array(AppMessage),
  lastSeq: z.int().min(0),
});
export type ChannelSnapshotEvent = z.infer<typeof ChannelSnapshotEvent>;

/** Catch-up done: replay/snapshot delivered, live events follow. */
export const ChannelSyncedEvent = z.object({
  channelId: z.string().min(1),
  lastSeq: z.int().min(0),
});
export type ChannelSyncedEvent = z.infer<typeof ChannelSyncedEvent>;

export const ConversationUpdatedEvent = z.object({
  channelId: z.string().min(1),
  conversation: Conversation,
});
export type ConversationUpdatedEvent = z.infer<typeof ConversationUpdatedEvent>;

/** Broadcast to every helloed peer — a client learns of new channels live. */
export const ChannelCreatedEvent = z.object({ channel: AppChannel });
export type ChannelCreatedEvent = z.infer<typeof ChannelCreatedEvent>;

/** Broadcast when a channel is deleted (e.g. its employee was removed). */
export const ChannelRemovedEvent = z.object({ channelId: z.string().min(1) });
export type ChannelRemovedEvent = z.infer<typeof ChannelRemovedEvent>;

/** Broadcast on employees.create / employees.update so all clients upsert. */
export const EmployeeUpsertedEvent = z.object({ employee: Employee });
export type EmployeeUpsertedEvent = z.infer<typeof EmployeeUpsertedEvent>;

/** Broadcast on employees.remove so all clients drop the record. */
export const EmployeeRemovedEvent = z.object({ employeeId: z.string().min(1) });
export type EmployeeRemovedEvent = z.infer<typeof EmployeeRemovedEvent>;

/** Broadcast on profile.update — every connected surface sees the edit. */
export const ProfileUpdatedEvent = z.object({ profile: ProfileSettings });
export type ProfileUpdatedEvent = z.infer<typeof ProfileUpdatedEvent>;

export const AskOpenedEvent = z.object({
  channelId: z.string().min(1),
  ask: Ask,
});
export type AskOpenedEvent = z.infer<typeof AskOpenedEvent>;

export const AskResolvedEvent = z.object({
  channelId: z.string().min(1),
  ask: Ask,
});
export type AskResolvedEvent = z.infer<typeof AskResolvedEvent>;

/**
 * A client asked for the conversation's running turn to be interrupted; the
 * registered engine host relays it to the engine as `interrupt`.
 */
export const TurnInterruptRequestedEvent = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
});
export type TurnInterruptRequestedEvent = z.infer<
  typeof TurnInterruptRequestedEvent
>;

/**
 * A client pinned a model on a conversation (`conversations.setModel`); the
 * registered engine host answers with `session.setModel` (or stores the pin
 * for `session.start` when no engine session is bound yet).
 */
export const ConversationModelRequestedEvent = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
});
export type ConversationModelRequestedEvent = z.infer<
  typeof ConversationModelRequestedEvent
>;

/* -------------------------------- settings ------------------------------- */

/**
 * LilOS-owned settings KV (`settings.get`/`settings.set`): client-owned data
 * that must survive restarts and be shared by every surface — e.g. the
 * model picker's hide list (#92). Keys are namespaced by the writer
 * ("modelVisibility", ...); `value` is any JSON-serializable value.
 */
export const SettingsGetParams = z.strictObject({
  key: z.string().min(1),
});
export type SettingsGetParams = z.infer<typeof SettingsGetParams>;

export const SettingsGetResult = z.object({
  /** The stored value, or null when the key was never set. */
  value: z.unknown(),
});
export type SettingsGetResult = z.infer<typeof SettingsGetResult>;

export const SettingsSetParams = z.strictObject({
  key: z.string().min(1),
  /* `z.unknown()` alone makes the key optional — an absent `value` parsed
     clean and hit the store's NOT NULL column as a 500. The write is a
     value store: the field is required (any JSON, `null` included). */
  value: z.json(),
});
export type SettingsSetParams = z.infer<typeof SettingsSetParams>;

export const SettingsSetResult = z.object({ ok: z.literal(true) });
export type SettingsSetResult = z.infer<typeof SettingsSetResult>;

/** Broadcast on `settings.set` so every client sees the change live. */
export const SettingsChangedEvent = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});
export type SettingsChangedEvent = z.infer<typeof SettingsChangedEvent>;

/* ------------------------- phone pairing (#153) --------------------------
 *
 * Pairing = one-time grant in the QR → exchanged over plain HTTP
 * (`POST /pair/exchange`, same Hono app on the Tailscale-bound listener) for
 * a per-device credential the phone then presents in `session.hello`.
 * The relay install token never enters the pairing flow.
 */

/**
 * `pairing.offer` — the Mac-side opt-in: on success the relay has bound its
 * Tailscale listener and minted a fresh one-time grant. When Tailscale isn't
 * running it fails `tailscale_unavailable` (the dialog renders its "turn on
 * Tailscale" state instead of a QR).
 */
export const PairingOffer = z.object({
  /** Tailscale host the phone reaches — `name-or-ip:port` (never loopback). */
  host: z.string().min(1),
  /** One-time grant; the only secret in the QR/URL, kept in the fragment. */
  code: z.string().min(1),
  /** This Mac's display name (e.g. "Oscar's Mac"). */
  name: z.string().min(1),
  /** Grant expiry, epoch ms (5 min from minting). */
  expiresAt: Timestamp,
});
export type PairingOffer = z.infer<typeof PairingOffer>;

export const PairingOfferResult = z.object({ offer: PairingOffer });
export type PairingOfferResult = z.infer<typeof PairingOfferResult>;

export const DevicesListResult = z.object({
  devices: z.array(PairedDevice),
});
export type DevicesListResult = z.infer<typeof DevicesListResult>;

export const DevicesRevokeParams = z.strictObject({
  deviceId: z.string().min(1),
});
export type DevicesRevokeParams = z.infer<typeof DevicesRevokeParams>;

/**
 * Broadcast when the device roster changes (a phone paired, a device revoked)
 * so every client refreshes without polling.
 */
export const DevicesChangedEvent = z.object({
  devices: z.array(PairedDevice),
});
export type DevicesChangedEvent = z.infer<typeof DevicesChangedEvent>;

/** `POST /pair/exchange` body — the phone's one shot at spending its grant. */
export const PairingExchangeParams = z.strictObject({
  code: z.string().min(1),
  /** The phone's own display name ("Oscar's iPhone"); default below. */
  name: z.string().min(1).optional(),
});
export type PairingExchangeParams = z.infer<typeof PairingExchangeParams>;

export const PairingExchangeResult = z.object({
  deviceId: z.string().min(1),
  /** The raw per-device credential — the only place it ever appears. */
  credential: z.string().min(1),
  device: PairedDevice,
});
export type PairingExchangeResult = z.infer<typeof PairingExchangeResult>;

/** Body of a refused exchange (`used` = replay, `expired` = TTL ran out). */
export const PairingExchangeError = z.object({
  error: z.enum(["unknown", "expired", "used"]),
});
export type PairingExchangeError = z.infer<typeof PairingExchangeError>;

export { APP_PROTOCOL_VERSION };
