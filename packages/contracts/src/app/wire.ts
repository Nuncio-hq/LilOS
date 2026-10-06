import { z } from "zod";
import {
  AgentsCreateParams,
  AgentsDescribeParams,
  AgentsListParams,
  AgentsUpdateParams,
} from "../engine/agents";
import {
  ApprovalsSetPolicyParams,
  ConversationAccess,
} from "../engine/approvals";
import { Capability } from "../engine/capabilities";
import { EngineEvent } from "../engine/events";
import {
  JobsListParams,
  JobsStopParams,
  SessionAskParams,
} from "../engine/methods";
import { ModelOption, ModelProvider, ModelsListParams } from "../engine/models";
import { ApprovalOutcome, EngineRequest } from "../engine/requests";
import { ForgePrListItem } from "../host/forge";
import {
  AppChannel,
  AppMessage,
  Ask,
  AskState,
  AuthorKind,
  Conversation,
  ConversationLife,
  ConversationState,
  ConversationSummary,
  Employee,
  EmployeeStatus,
  EngineHostState,
  EngineHostStatus,
  MessageAttachment,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  PushPrefs,
  RecentFolder,
  RespondTo,
  Timestamp,
  TurnFailure,
  WorkbenchOpenTarget,
  WorkspaceIntent,
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

/**
 * WebSocket close codes that carry protocol meaning (4000–4999 is the
 * application range; `session.hello` failures close 4000). `devices.revoke`
 * drops the phone's live sockets with this code so the client can tell
 * "your credential is dead" apart from a lost transport — the app must
 * re-pair, not reconnect.
 */
export const WS_CLOSE_DEVICE_REVOKED = 4403;

/**
 * #625: an upgraded socket that never completes `session.hello` is closed
 * with this code once the hello deadline passes — a silent peer can't sit
 * pre-auth buffering frames. Clients need no special handling: the drop
 * reads as an ordinary transport loss and reconnects.
 */
export const WS_CLOSE_HELLO_TIMEOUT = 4408;

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
  /* Rewind a conversation to just before one of its user messages (#134). */
  "conversations.rewind",
  "messages.list",
  "messages.post",
  /* Host-only: stamp the pre-turn folder checkpoint onto a user message. */
  "messages.setCheckpoint",
  /* #315 waiting tray: remove a still-waiting user message (the engine
     never gets it), park a queued one in the not-sent tray (host-only —
     the harness's Stop drain calls it), and un-park it to send. */
  "messages.remove",
  "messages.drop",
  "messages.send",
  /* Host-only: mark a send claimed by the engine pipeline (#377). */
  "messages.claim",
  "messages.search",
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
  /* The composer pill's access switch (#106) — user-only, the relay stamps
     the new level on the conversation and `conversation.updated` carries
     it; the next approval request is routed by the fresh value. */
  "conversations.setAccess",
  /* Engine-event replay scoped to one conversation (#157): a device-scope
     client (the phone) replays the turn stream through the relay — the
     relay resolves the conversation's `engineRef` and forwards
     `events.since` to the host; no engine socket, no verbatim passthrough. */
  "session.events",
  /* Host-only: re-publish one engine event of a conversation-bound session
     so the relay can re-emit it on the conversation's channel (#157). */
  "engine.event",
  /* A thread's pull requests (#159): conversationId-scoped like
     `session.events` — the relay resolves the conversation's folder +
     branch(es) and calls the host's `forge.prs`; the raw path never crosses
     the phone boundary. */
  "conversations.prs",
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
  /* Live probe of one recents-listed folder: branches + workstreams, so a
     device-scope client (the phone) can pick a workspace mode (#156). The
     host feed that computes this stays loopback-only; the relay forwards
     the call to the harness. */
  "folders.detail",
  /* The phone's "Other folder on the Mac…" sheet (#238): `folders.browse`
     lists one folder level and `folders.discover` returns the "Found on
     this Mac" repos. Device-scope allowed like `folders.detail` — the
     relay forwards both to the harness, which enforces the home-folder
     boundary server-side; the raw host fs feed stays loopback-only. */
  "folders.browse",
  "folders.discover",
  /* The signed-in human's identity — name, company, avatar colour (#118).
     `settings.*` is #92's KV namespace, so the profile uses `profile.*`. */
  "profile.get",
  "profile.update",
  /* engine passthrough: forwarded verbatim to the registered engine host */
  "agents.list",
  "agents.describe",
  "agents.create",
  "agents.update",
  "models.list",
  "jobs.list",
  "jobs.stop",
  /* The engine's global approval policy (#106) — Settings writes it through
     the same passthrough the model catalog uses. */
  "approvals.setPolicy",
  /* One-shot side ask (#584): the Workbench's commit-message "Suggest" —
     forwarded to the engine's session.ask. */
  "session.ask",
  /* Phone pairing (#153): minting a grant is the opt-in that also binds the
     Tailscale listener; devices.list/revoke manage what the grant exchange
     created. `pairing.disable` turns phone access off again. */
  "pairing.offer",
  "pairing.disable",
  "devices.list",
  "devices.revoke",
  /* Keep-vs-replace probe (#154): the mobile connection supervisor pings the
     live socket before deciding to replace it; a request that can't answer
     inside a small timeout marks the transport dead. */
  "session.ping",
  /* Push notifications (#161): a paired phone registers its Expo push token
     + per-kind toggles, reports which thread it has open (push suppression),
     and unregisters on forget. Device scope only. */
  "push.register",
  "push.unregister",
  "push.visibility",
  /* Host-only (#340): the session's `workbench_open` tool asks the app to
     open the conversation's Workbench on a target — the relay fans
     `workbench.opened` out on the channel. It rides the app wire, never the
     engine event stream: a synthesized event seq would poison `events.since`
     replay and the push watermark. */
  "workbench.open",
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
  "agents.update",
  "models.list",
  "jobs.list",
  "jobs.stop",
  "approvals.setPolicy",
  "session.ask",
] as const;
export type EnginePassthroughMethod =
  (typeof ENGINE_PASSTHROUGH_METHODS)[number];

/** Params schema per passthrough method, for the relay's validate-then-forward gate. */
export const ENGINE_PASSTHROUGH_PARAMS = {
  "agents.list": AgentsListParams,
  "agents.describe": AgentsDescribeParams,
  "agents.create": AgentsCreateParams,
  "agents.update": AgentsUpdateParams,
  "models.list": ModelsListParams,
  "jobs.list": JobsListParams,
  "jobs.stop": JobsStopParams,
  "approvals.setPolicy": ApprovalsSetPolicyParams,
  "session.ask": SessionAskParams,
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

export const SessionPingParams = z.object({}).strict();
export const SessionPingResult = z.object({
  ok: z.literal(true),
  /** Relay run identity — the probe answer doubles as an instanceId check. */
  instanceId: z.string().min(1),
});
export type SessionPingResult = z.infer<typeof SessionPingResult>;

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

/**
 * Largest single attachment the relay stores, in decoded bytes. Raising
 * these caps must raise `MAX_FRAME_BYTES` (`../engine/envelope.ts`) too —
 * the transport ceiling exists to fit this maximal send (#551).
 */
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
    /** Folder the session works in (#113); absent = harness default workdir.
        For a workstream open (#156) this is the worktree path. */
    cwd: z.string().min(1).optional(),
    /** Workstream mode (#156): `new` asks the harness to create `cwd` as a
        worktree of `workspace.repoPath` before `session.start`; `existing`
        resumes the workstream already at `cwd`. Absent = direct folder. */
    workspace: WorkspaceIntent.optional(),
    /** The new conversation's access level (#106); absent = Settings'
        default (`defaultAccess`, fallback `"ask"`). */
    access: ConversationAccess.optional(),
    /**
     * Exactly-once key for retried opens (#552): a re-open with a key the
     * channel already recorded returns the original conversation + root
     * message instead of minting a second thread (no `message.created` /
     * `conversation.updated` re-emitted either). Same (channelId, key)
     * slot `messages.post` dedupes on.
     */
    dedupeKey: z.string().min(1).max(200).optional(),
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
  /** Host-only (#346): the engine session's life — `closed` once suspended,
      back to `open` when it reopens. `running` is derived client-side. */
  life: ConversationLife.optional(),
  /** Host-only (#419): the last turn's failure the DM card shows —
      `null` clears it (the next `turn.started` erases the card). */
  turnFailure: TurnFailure.nullable().optional(),
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
  /** #134: include the hidden rewound tail (audit reads); default hides it. */
  includeRewound: z.boolean().optional(),
  /** #315: include Stop-parked `dropped` rows (the not-sent tray reads them);
      default hides them alongside `removed` rows, which never surface. */
  includeDropped: z.boolean().optional(),
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
 * #315: the waiting tray's Remove (and a not-sent item's Remove): marks the
 * message `removed` — hidden everywhere and never delivered to the engine.
 * The relay refuses when the engine already consumed it (deliveredSeq covers
 * it and it isn't parked) — the action isn't offered client-side then either.
 */
export const MessagesRemoveParams = z.strictObject({
  messageId: z.string().min(1),
});
export type MessagesRemoveParams = z.infer<typeof MessagesRemoveParams>;

/**
 * #315: host-only — the harness parks a still-waiting message in the
 * not-sent tray on ■ Stop (`dropped` — hidden, `listPendingTurns` skips it,
 * `messages.send` un-parks). Idempotent.
 */
export const MessagesDropParams = z.strictObject({
  messageId: z.string().min(1),
});
export type MessagesDropParams = z.infer<typeof MessagesDropParams>;

/**
 * #315: the not-sent tray's Send — clears `dropped`; the harness re-delivers
 * it like a fresh message. Only valid on a parked row.
 */
export const MessagesSendParams = z.strictObject({
  messageId: z.string().min(1),
});
export type MessagesSendParams = z.infer<typeof MessagesSendParams>;

/**
 * #377: host-only — the harness marks a send `claimed` the moment its prompt
 * commits to dispatch (before the checkpoint/wire awaits). A claimed row
 * leaves the waiting tray: Remove isn't offered on a send that can no
 * longer be reordered, and the row renders as its own user bubble until
 * `turn.started` consumes it. Idempotent; re-claim on redelivery is a no-op.
 */
export const MessagesClaimParams = z.strictObject({
  messageId: z.string().min(1),
  /* #403: `false` un-claims — the send came to rest short of the wire
     (queued, pending steer, re-queued) so the waiting tray owns it again. */
  claimed: z.boolean().default(true),
});
export type MessagesClaimParams = z.infer<typeof MessagesClaimParams>;

/**
 * Full-text search over the relay's stored messages (issue #138). Search
 * covers visible message text only (D-#25): engine transcripts, tool output
 * and attachment bytes are never indexed. `query` is the user's raw text —
 * the relay builds the FTS expression (terms AND'd, the last term matched
 * as a prefix so the box can filter while typing). `conversationId` is null
 * on hits belonging to no thread.
 */
export const MessagesSearchParams = z.object({
  query: z.string().min(1),
  channelId: z.string().min(1).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.int().min(1).max(200).default(50),
});
export type MessagesSearchParams = z.infer<typeof MessagesSearchParams>;

/**
 * One matched message. `snippet` is an excerpt of the message text with
 * each matched term wrapped in `<mark>…</mark>` (the UI parses the tags
 * back into elements — it never renders the string as HTML).
 */
export const MessageSearchHit = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1).nullable(),
  channelId: z.string().min(1),
  /* Who wrote the matching message — the hit row shows it ("anyone said it"). */
  authorId: z.string().min(1),
  snippet: z.string(),
  createdAt: Timestamp,
});
export type MessageSearchHit = z.infer<typeof MessageSearchHit>;

export const MessagesSearchResult = z.object({
  hits: z.array(MessageSearchHit),
});
export type MessagesSearchResult = z.infer<typeof MessagesSearchResult>;

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
 * `folders.detail { path }` (#156): live branch/workstream probe of ONE
 * recents-listed folder — the relay refuses paths `folders.list` doesn't
 * already know, so a device peer can read workspaces of folders the Mac
 * picked, nothing wider. Answered by the harness (the only process that
 * can run git on the session machine): `engine_unavailable` when no host
 * is registered, `not_found` when the path isn't in recents.
 */
export const FoldersDetailParams = z.strictObject({
  /** A path verbatim from `folders.list` (the picker's stored form). */
  path: z.string().min(1),
});
export type FoldersDetailParams = z.infer<typeof FoldersDetailParams>;

/** A linked git worktree the picker offers as "Continue a workstream". */
export const FolderWorkstream = z.object({
  /** Branch checked out in the worktree. */
  branch: z.string().min(1),
  /** Worktree directory on the session machine (`~`-collapsed). */
  path: z.string().min(1),
  /** Ref the branch forked from (branch reflog, best-effort). */
  from: z.string().optional(),
});
export type FolderWorkstream = z.infer<typeof FolderWorkstream>;

export const FoldersDetailResult = z.object({
  /** Echo of the probed path (as passed). */
  path: z.string(),
  /** The folder is gone from the session machine. */
  missing: z.boolean(),
  isRepo: z.boolean(),
  /** Repo work-tree root when isRepo (`~`-collapsed). */
  root: z.string().optional(),
  /** Current branch; null on detached/unborn HEAD or non-repo. */
  current: z.string().nullable().optional(),
  /** Local branches, current first then name-sorted (empty on non-repo). */
  branches: z.array(z.string()),
  remote: z.string().nullable().optional(),
  /** Linked worktrees with a branch (the repo's own checkout excluded). */
  workstreams: z.array(FolderWorkstream),
});
export type FoldersDetailResult = z.infer<typeof FoldersDetailResult>;

/**
 * `folders.browse { path }` (#238): one folder level on the session
 * machine, for the phone's folder browser. Sub-folders only — files and
 * dot-dirs are never listed — each repo root carrying its checked-out
 * branch. The harness refuses paths that don't resolve under the Mac
 * user's home (`..` escapes, absolute paths outside home, symlink hops
 * out, dot-dir segments).
 */
export const FoldersBrowseParams = z.strictObject({
  /** `~`, `~/x`, or an absolute path under the Mac's home. */
  path: z.string().min(1),
});
export type FoldersBrowseParams = z.infer<typeof FoldersBrowseParams>;

/** A folder on the Mac, as the phone's browser lists it (#238). */
export const MacFolderEntry = z.object({
  /** Display name — the last path segment. */
  name: z.string().min(1),
  /** `~`-collapsed absolute path — verbatim input to `folders.browse`/`folders.add`. */
  path: z.string().min(1),
  /** Checked-out branch when the folder is a git repo root. */
  branch: z.string().min(1).optional(),
});
export type MacFolderEntry = z.infer<typeof MacFolderEntry>;

export const FoldersBrowseResult = z.object({
  /** The listed folder, `~`-collapsed. */
  path: z.string().min(1),
  /** Current branch when the listed folder sits inside a git repo. */
  branch: z.string().min(1).optional(),
  /** Non-hidden sub-folders only. */
  folders: z.array(MacFolderEntry),
});
export type FoldersBrowseResult = z.infer<typeof FoldersBrowseResult>;

/**
 * `folders.discover` (#238): repos the Mac found under the same roots the
 * web's "Found on this Mac" scans (`~/Desktop`, `~/Developer`,
 * `~/Documents`, `~/repos`) — the phone browser's home-screen group.
 */
export const FoldersDiscoverParams = z.object({}).strict();
export type FoldersDiscoverParams = z.infer<typeof FoldersDiscoverParams>;

/** A repo the Mac found — the phone browser's "Found on this Mac" row. */
export const MacFoundRepo = z.object({
  /** Repo root, `~`-collapsed. */
  path: z.string().min(1),
  /** Checked-out branch; absent on a detached/unborn HEAD. */
  branch: z.string().min(1).optional(),
});
export type MacFoundRepo = z.infer<typeof MacFoundRepo>;

export const FoldersDiscoverResult = z.object({
  repos: z.array(MacFoundRepo),
});
export type FoldersDiscoverResult = z.infer<typeof FoldersDiscoverResult>;

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

/* Per-profile LilOS connection state (#339, agent gateway #336): "connected"
   = the profile's lilos plugin is enabled; "not-connected" = the one-time
   approval was never given or was declined; "updating" = a connect or plugin
   update is in flight; "failed" = the last attempt failed and `reason`
   carries the plain why. LilOS only enables/disables the plugin — it never
   deletes a profile. `packages/ui/src/types.ts` mirrors this shape. */
export const ConnectionState = z.enum([
  "connected",
  "not-connected",
  "updating",
  "failed",
]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/** One profile's connection row — the Connect step and Settings → Engine
    both read this off `system.status`. */
export const ProfileConnection = z.object({
  /** Engine profile id (`agents.*` handle). */
  profile: z.string().min(1),
  /** Display name of the employee hired on this profile, when there is one. */
  employee: z.string().optional(),
  state: ConnectionState,
  /** Plain reason shown when state is "failed". */
  reason: z.string().optional(),
});
export type ProfileConnection = z.infer<typeof ProfileConnection>;

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
  /** Per-profile LilOS connection rows (#339) — absent when the host never
     reported them (engine without connect support, older harness). */
  connect: z.array(ProfileConnection).optional(),
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
  /** Per-profile Connect rows (#339) — served verbatim on `system.status`. */
  connect: z.array(ProfileConnection).optional(),
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
 * Any client: rewind a conversation to just before one of its user messages
 * (issue #134). The relay forwards to the engine host, which restores the
 * folder checkpoint stamped on that message (harness-owned shadow git store)
 * and — when the bound engine session declares the `rewind` capability —
 * drops the message and everything after it from the engine's context. On
 * success the relay marks those messages `rewound` (hidden, kept for audit)
 * and emits `conversation.rewound`; the UI puts the message's text and
 * images back into the composer.
 */
export const ConversationsRewindParams = z
  .object({
    conversationId: z.string().min(1),
    /** The user message to rewind to — it and everything after are dropped. */
    messageId: z.string().min(1),
  })
  .strict();
export type ConversationsRewindParams = z.infer<
  typeof ConversationsRewindParams
>;

export const ConversationsRewindResult = z.object({
  /** The rewound user message — its text + attachments feed the composer. */
  message: AppMessage,
  /**
   * False when the session's transport cannot rewind history (ACP today):
   * files were restored but the engine still remembers the later turns —
   * the UI explains that and offers "Start a new session from here".
   */
  engineRewound: z.boolean(),
  /**
   * False when no pre-turn checkpoint was stamped on the message (e.g. it
   * predates #134) — the conversation still dropped but no files moved.
   */
  filesRestored: z.boolean(),
  /** Number of trailing messages the relay marked rewound. */
  removedCount: z.int().min(0),
  /** The dropped messages' ids — the engine feed's `ref`s to filter by. */
  removedIds: z.array(z.string()),
});
export type ConversationsRewindResult = z.infer<
  typeof ConversationsRewindResult
>;

/**
 * The relay→host `conversations.rewind` call (issue #134): the relay computes
 * the surviving user-turn count and the checkpoint to restore; the host owns
 * the folder restore and the engine-side rewind.
 */
export const ConversationsRewindHostParams = z
  .object({
    conversationId: z.string().min(1),
    /** The conversation's engine session id, when one was bound. */
    engineRef: z.string().nullable(),
    /** The rewound message (echo for the host's logs/dedup). */
    messageId: z.string().min(1),
    /** Shadow-git checkpoint stamped on the message; null = no restore. */
    checkpoint: z.string().nullable(),
    /** Session folder to restore; null = the host's workdir. */
    cwd: z.string().nullable(),
    /** First seq to drop — queued sends at/after it are discarded. */
    fromSeq: z.int().min(0),
    /** Visible user turns that survive — the engine drops the rest. */
    toTurn: z.int().min(0),
  })
  .strict();
export type ConversationsRewindHostParams = z.infer<
  typeof ConversationsRewindHostParams
>;

export const ConversationsRewindHostResult = z
  .object({
    /** The engine's session actually dropped its turns (capability path). */
    engineRewound: z.boolean(),
    /** The folder was restored to the checkpoint. */
    filesRestored: z.boolean(),
  })
  .strict();
export type ConversationsRewindHostResult = z.infer<
  typeof ConversationsRewindHostResult
>;

/**
 * Host-only: stamp the pre-turn folder checkpoint id onto a user message
 * (issue #134) — the rewind target `conversations.rewind` restores.
 */
export const MessagesSetCheckpointParams = z
  .object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    checkpoint: z.string().min(1),
  })
  .strict();
export type MessagesSetCheckpointParams = z.infer<
  typeof MessagesSetCheckpointParams
>;

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

/**
 * Switch a conversation's access level (#106) — the composer pill writes
 * it directly on the conversation (LilOS data, user-only). The relay stamps
 * it and emits `conversation.updated`; the next approval request routes by
 * the fresh value, mid-turn included. Never agent-facing: an agent must
 * never grant itself Full access.
 */
export const ConversationsSetAccessParams = z
  .object({
    conversationId: z.string().min(1),
    access: ConversationAccess,
  })
  .strict();
export type ConversationsSetAccessParams = z.infer<
  typeof ConversationsSetAccessParams
>;

/**
 * Engine-event replay for a client that only sees conversations (#157):
 * `{conversationId, after}` — the relay resolves `engineRef` and calls the
 * host's `events.since`; the result is the engine's `EventsSinceResult`
 * verbatim. `not_found` when the conversation doesn't exist or has no engine
 * session bound yet (nothing to replay — treat as an empty feed).
 */
export const SessionEventsParams = z
  .object({
    conversationId: z.string().min(1),
    /** Replay watermark: events with seq > after are returned. */
    after: z.int().min(0),
  })
  .strict();
export type SessionEventsParams = z.infer<typeof SessionEventsParams>;

/**
 * Host-only push (#157): the registered engine host re-publishes every
 * engine event of a conversation-bound session so the relay can re-emit it
 * as the `engine.event` channel event. `conversationId` comes from the
 * host's own session binding — the relay drops frames for unknown
 * conversations (e.g. a session bound after the push raced its bind).
 */
export const EngineEventParams = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
    event: EngineEvent,
  })
  .strict();
export type EngineEventParams = z.infer<typeof EngineEventParams>;

/**
 * A thread's pull requests through the relay (#159): `{conversationId}` —
 * the relay resolves the conversation's folder (`cwd` or the picked
 * `workspace.repoPath`) and head branch(es) and calls the host's
 * `forge.prs` on the harness. A device peer can only ever ask inside a
 * conversation the relay already knows; a just-chat thread (no folder)
 * answers `prs: []` without a host call. Host failures — not a repo, `gh`
 * missing or signed out — surface as errors; the app treats them as "no
 * PRs" (AC-4).
 */
export const ConversationsPrsParams = z
  .object({
    conversationId: z.string().min(1),
  })
  .strict();
export type ConversationsPrsParams = z.infer<typeof ConversationsPrsParams>;

export const ConversationsPrsResult = z.object({
  /** Open → draft → merged → closed, newest first inside each state. */
  prs: z.array(ForgePrListItem),
});
export type ConversationsPrsResult = z.infer<typeof ConversationsPrsResult>;

/* -------------------------------- events ------------------------------- */

export const AppEventMethod = z.enum([
  "message.created",
  /* #315: a message's dropped/removed flags changed — subscribers replace
     their copy (it does not re-fire `message.created`, seq is unchanged). */
  "message.changed",
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
  "conversation.rewound",
  "devices.changed",
  "host.changed",
  "connect.changed",
  "engine.event",
  "workbench.opened",
]);
export type AppEventMethod = z.infer<typeof AppEventMethod>;

export const MessageCreatedEvent = z.object({
  channelId: z.string().min(1),
  message: AppMessage,
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEvent>;

/** #315: `dropped`/`removed` flipped on an existing row — replace it. */
export const MessageChangedEvent = z.object({
  channelId: z.string().min(1),
  message: AppMessage,
  /* #403: which flags this frame flipped (`"removed"`, `"dropped"`,
     `"claimed"`) — lets a receiver tell a Send (`dropped` cleared) from a
     lane bookkeeping flip (`claimed` only), whose row it must NOT
     re-deliver. */
  flags: z.array(z.string().min(1)).optional(),
});
export type MessageChangedEvent = z.infer<typeof MessageChangedEvent>;

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
  /* #403: the channel seq the interrupt logically follows — every send at
     or below it predates the Stop. Bus events and `channelMessages` rows
     travel unordered paths to the host, so the stamp (not arrival order)
     marks the causal boundary. */
  afterSeq: z.int().min(0),
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

/**
 * A conversation was rewound (issue #134): every message on it with
 * `seq >= fromSeq` is now marked `rewound` — hidden, kept for audit. Clients
 * drop them from the rendered thread and refresh summaries.
 */
export const ConversationRewoundEvent = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  /** First rewound seq — the target user message itself. */
  fromSeq: z.int().min(0),
  /** The user message whose checkpoint was the restore point. */
  messageId: z.string().min(1),
  /** Whether the engine session also dropped the turns (false = ACP). */
  engineRewound: z.boolean(),
  /** The dropped messages' ids — the engine feed's `ref`s to filter by. */
  removedIds: z.array(z.string()),
});
export type ConversationRewoundEvent = z.infer<typeof ConversationRewoundEvent>;

/**
 * A live engine event re-published by the registered host (#157): the relay
 * emits it on the conversation's channel so subscribed clients (the phone)
 * render the turn stream through `reduceSessionEvents` — the same feed the
 * host exposes on its loopback port, scoped to what a channel reader may see.
 */
export const EngineEventEvent = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  sessionId: z.string().min(1),
  event: EngineEvent,
});
export type EngineEventEvent = z.infer<typeof EngineEventEvent>;

/**
 * `workbench.open` params (#340) — host-only like `engine.event`: the harness
 * turns a session's `workbench_open` tool call into this method; the relay
 * resolves the conversation's channel and emits `workbench.opened`.
 */
export const WorkbenchOpenParams = z.strictObject({
  conversationId: z.string().min(1),
  target: WorkbenchOpenTarget,
});
export type WorkbenchOpenParams = z.infer<typeof WorkbenchOpenParams>;

/**
 * An employee asked to show something in its DM's Workbench (#340): desktop
 * opens the panel on the target's tab, the phone renders a tappable card in
 * the thread that opens the same view.
 */
export const WorkbenchOpenedEvent = z.object({
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  target: WorkbenchOpenTarget,
});
export type WorkbenchOpenedEvent = z.infer<typeof WorkbenchOpenedEvent>;

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

/** Body of a refused exchange (`used` = replay, `expired` = TTL ran out,
    `throttled` = too many `unknown` guesses — #568, retry after 60s). */
export const PairingExchangeError = z.object({
  error: z.enum(["unknown", "expired", "used", "throttled"]),
});
export type PairingExchangeError = z.infer<typeof PairingExchangeError>;

/**
 * Broadcast when the engine host registers or its socket dies, and on every
 * `harness.report` engine-state flip (#482 — a dying backend behind a live
 * adapter now reports `restarting`/`failed`, and the phone's Mac-sheet row +
 * the desktop System status must show the outage while it lasts, not on the
 * next status poll). Clients re-poll `system.status` on receipt (#148);
 * `engine` carries the reported lifecycle state so listeners that only patch
 * `welcome.engineHost` (no status call) still see the flip.
 */
export const HostChangedEvent = z.object({
  connected: z.boolean(),
  engine: z
    .object({ state: EngineHostState, detail: z.string().optional() })
    .optional(),
});
export type HostChangedEvent = z.infer<typeof HostChangedEvent>;

/**
 * Broadcast when the per-profile Connect rows the relay serves on
 * `system.status` change (#413): the DM notice and Settings → Engine read
 * them live instead of waiting for the next status poll. `connect` absent
 * = the host stopped reporting rows — clients clear their copy. A later
 * `system.status` answer stays authoritative and replaces the patched rows.
 */
export const ConnectChangedEvent = z.object({
  connect: z.array(ProfileConnection).optional(),
});
export type ConnectChangedEvent = z.infer<typeof ConnectChangedEvent>;

/* ------------------------ push notifications (#161) ------------------------
 *
 * Device-scope only: the registration is tied to the `deviceId` a phone's
 * `session.hello` authenticated with — `devices.revoke` drops the token
 * alongside the device. The relay fans one Expo push per transition
 * (`asks.open` created; `engine.event` `turn.completed`/`session.state`
 * error) out to every registered device whose prefs + visibility allow it.
 */

/**
 * `push.register` — upsert this device's Expo push token and per-kind
 * toggles. Sent after pairing and on every foreground; re-sends are
 * idempotent. `token` is the `ExponentPushToken[...]` from
 * `getExpoPushTokenAsync` (opaque to the relay).
 */
export const PushRegisterParams = z.strictObject({
  token: z.string().min(1),
  prefs: PushPrefs,
});
export type PushRegisterParams = z.infer<typeof PushRegisterParams>;

export const PushOkResult = z.object({ ok: z.literal(true) });
export type PushOkResult = z.infer<typeof PushOkResult>;

/** `push.unregister` — drop this device's registration (forget-Mac path). */
export const PushUnregisterParams = z.object({}).strict();
export type PushUnregisterParams = z.infer<typeof PushUnregisterParams>;

/**
 * `push.visibility` — which thread this phone currently has open in the
 * foreground (null = none visible / app backgrounded). The relay suppresses
 * pushes for a conversation the phone is already looking at.
 */
export const PushVisibilityParams = z.strictObject({
  conversationId: z.string().nullable(),
});
export type PushVisibilityParams = z.infer<typeof PushVisibilityParams>;

export { APP_PROTOCOL_VERSION };
