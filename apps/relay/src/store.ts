import { randomUUID } from "node:crypto";
import type {
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
  MessageAttachment,
  MessageSearchHit,
  MessagesSearchParams,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  PushPrefs,
  RecentFolder,
  RespondTo,
  WorkspaceIntent,
} from "@lilos/contracts/app";
import type {
  ApprovalOutcome,
  EngineRequest,
  Usage,
} from "@lilos/contracts/engine";

/**
 * Retired system notes dropped on read (#196): the "No folder: working in
 * …" note a pre-#196 harness stored under `sys:<conversationId>:no-folder`
 * (#113 AC-6, superseded). `NO_FOLDER_DEDUPE_LIKE` is its SQL LIKE shape for
 * the SQLite store; `noFolderDedupeKey` the row predicate for the memory one.
 */
export const NO_FOLDER_DEDUPE_LIKE = "sys:%:no-folder";
export const noFolderDedupeKey = (key: string | null | undefined): boolean =>
  !!key && key.startsWith("sys:") && key.endsWith(":no-folder");

interface NewEmployee {
  name: string;
  role: string;
  status: EmployeeStatus;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
}

type EmployeePatchInput = Partial<NewEmployee>;

export interface ConversationPatch {
  title?: string;
  /** Provenance of a `title` write (#137) — caller identity, not a wire
      field: `user` (non-host client) marks the name user-chosen forever;
      `auto` (engine host) applies only while the row isn't user-titled. */
  titleSource?: "auto" | "user";
  archived?: boolean;
  state?: ConversationState;
  engineRef?: string;
  /** The model pinned on the engine session (issue #30). `null` clears
      (a failed-pick restore, #92) — like the other pick fields. */
  model?: string | null;
  /** The rest of the session's pick (issue #92). `null` clears — a pick
      that drops a field must not leave the old value on the row. */
  provider?: string | null;
  effort?: string | null;
  fast?: boolean | null;
  deliveredSeq?: number;
}

export interface OpenConversationInput {
  channelId: string;
  /** Empty = store derives a placeholder from `text`/`attachments` (#137). */
  title: string;
  /** What an explicit `title` means (#137): the opener is a user client
      ("user") or the engine host ("auto"). Ignored for placeholders. */
  titleSource?: "auto" | "user";
  text: string;
  authorId: string;
  /** Display refs only — bytes already stored via the AttachmentStore. */
  attachments?: MessageAttachment[];
  /** The composer's pick stamped at open (#92) — `session.start` applies it. */
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Folder the session works in (#113); also bumps the recents list. For a
      workstream open (#156) this is the worktree path and `workspace.repoPath`
      bumps recents instead. */
  cwd?: string;
  /** Workstream pick stamped at open (#156): new/existing worktree of
      `repoPath`; absent = `cwd` is the folder itself. */
  workspace?: WorkspaceIntent;
}

export interface AppendMessageInput {
  channelId: string;
  conversationId?: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  /** Display refs only — bytes already stored via the AttachmentStore. */
  attachments?: MessageAttachment[];
  /** Engine `turn.started.model` on employee answers (issue #30). */
  model?: string;
  /** Engine `turn.started` provider / effort / fast on employee answers (#92). */
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Exactly-once key: a retry with a recorded key returns the original message. */
  dedupeKey?: string;
}

export interface ListMessagesQuery {
  conversationId?: string;
  afterSeq?: number;
  limit?: number;
  /** Audit reads can ask for dropped messages back (#134); default hides them. */
  includeRewound?: boolean;
  /** The not-sent tray reads Stop-parked rows (#315); default hides them. */
  includeDropped?: boolean;
}

export interface ListMessagesPage {
  messages: AppMessage[];
  lastSeq: number;
}

/**
 * #138: search semantics shared by both stores — whitespace-split lowercase
 * terms, all must match (AND), except the last which is a prefix so the box
 * can filter while the user is mid-word.
 */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Word tokens the way the FTS unicode61 tokenizer sees them. */
const textTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);

/** Term match: earlier terms must hit a whole token; the last is a prefix. */
function messageMatchesTerms(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const toks = textTokens(text);
  return terms.every((t, i) =>
    i < terms.length - 1 ? toks.includes(t) : toks.some((w) => w.startsWith(t)),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* A relay-snippet-shaped excerpt for the memory store: a ~12-word window
   opening a few words before the first match (the SQLite side uses
   snippet(…, 12)), `…` at clipped edges, `<mark>` around every term hit. */
function markSnippet(text: string, terms: string[]): string {
  if (!terms.length) return text.slice(0, 96);
  const patterns = terms.map(
    (t, i) =>
      `(?<![\\w])${escapeRe(t)}${i < terms.length - 1 ? `(?![\\w])` : `[\\w]*`}`,
  );
  const re = new RegExp(patterns.join("|"), "gi");
  const first = re.exec(text);
  if (!first) return text.slice(0, 96);
  const words = [...text.matchAll(/\S+/g)];
  const hit = words.findIndex((w) => w.index + w[0].length > first.index);
  if (hit < 0) return text.slice(0, 96);
  const from = Math.max(0, hit - 3);
  const last = Math.min(words.length - 1, from + 11);
  const start = words[from].index;
  const end = words[last].index + words[last][0].length;
  const marked = text.slice(start, end).replace(re, (s) => `<mark>${s}</mark>`);
  return `${start > 0 ? "…" : ""}${marked}${end < text.length ? "…" : ""}`;
}

export interface ListConversationsQuery {
  channelId?: string;
  includeArchived: boolean;
}

export interface NewAsk {
  channelId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  request: EngineRequest;
}

export interface ResolveAskInput {
  outcome: ApprovalOutcome;
  answer?: string;
}

export interface ListAsksQuery {
  channelId?: string;
  conversationId?: string;
  state?: AskState;
}

/**
 * What the ws layer needs from persistence. Implemented by Drizzle+SQLite in
 * production (`db/drizzle-store.ts`) and by memory in tests — the protocol
 * machine is identical against both.
 */
export interface RelayStore {
  listEmployees(): Promise<Employee[]>;
  getEmployee(id: string): Promise<Employee | null>;
  createEmployee(input: NewEmployee): Promise<Employee>;
  updateEmployee(
    id: string,
    patch: EmployeePatchInput,
  ): Promise<Employee | null>;
  /**
   * Deletes the employee plus its whole LilOS-side graph (DM channel,
   * conversations, messages, asks) in one step. The engine profile is never
   * touched — engines own profiles; the relay only drops its own records.
   * Returns the deleted row + removed channel ids, or null when unknown.
   */
  removeEmployee(
    id: string,
  ): Promise<{ employee: Employee; channelIds: string[] } | null>;

  listChannels(): Promise<AppChannel[]>;
  getChannel(id: string): Promise<AppChannel | null>;
  /** Get-or-create the DM channel with this employee. */
  openDmChannel(
    employeeId: string,
  ): Promise<{ channel: AppChannel; created: boolean }>;

  listConversations(query: ListConversationsQuery): Promise<Conversation[]>;
  /**
   * Session-folder recents (#113): one shared list, newest-first. `add` is
   * an upsert on `path`; `openConversation` bumps the same row for `cwd`.
   */
  listRecentFolders(): Promise<RecentFolder[]>;
  addRecentFolder(path: string): Promise<RecentFolder>;
  /**
   * The signed-in human's profile (#118) — `{}` until the user sets it; the
   * app layers OS-derived prefill on top (AC-4). `updateProfile` merges
   * the given keys and returns the stored profile.
   */
  getProfile(): Promise<ProfileSettings>;
  updateProfile(patch: ProfileSettings): Promise<ProfileSettings>;
  /**
   * One row per conversation carrying the messages the session list renders
   * — the list survives the channel's snapshot window (#28 AC-1).
   */
  listConversationSummaries(
    query: ListConversationsQuery,
  ): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  /** Root message + conversation in one transaction. */
  openConversation(
    input: OpenConversationInput,
  ): Promise<{ conversation: Conversation; rootMessage: AppMessage }>;
  updateConversation(
    id: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null>;
  /**
   * Persist a turn.completed's usage on the conversation row (#300) — the
   * context meter's numbers, kept off the event stream so a dead engine
   * session can't take the meter with it. `sessionId`+`seq` are the
   * freshness fence: a replayed turn from the SAME session only writes
   * past the stored seq; a different session always writes (seq restarts
   * per session, so a rebind's first turn replaces the dead session's
   * numbers — dead sessions emit nothing, so a late same-id write can't
   * arrive post-rebind). Unknown conversations are dropped silently.
   */
  recordTurnUsage(input: {
    conversationId: string;
    sessionId: string;
    seq: number;
    usage: Usage;
  }): Promise<void>;

  listMessages(
    channelId: string,
    query: ListMessagesQuery,
  ): Promise<ListMessagesPage>;
  /**
   * Full-text search over stored message text (#138). Hits come back ordered
   * by relevance (best first); `includeArchived` keeps hits in archived
   * conversations, off by default like `conversations.list`. Only the hit
   * set is contractual — rank order differs between implementations.
   */
  searchMessages(params: MessagesSearchParams): Promise<MessageSearchHit[]>;
  /**
   * Appends with the channel's next seq (atomic with the counter bump).
   * `dedupeKey` makes the write idempotent: `created: false` returns the
   * message the first call stored.
   */
  appendMessage(
    input: AppendMessageInput,
  ): Promise<{ message: AppMessage; created: boolean }>;

  getMessage(id: string): Promise<AppMessage | null>;
  /** Stamp the pre-turn folder checkpoint onto a user message (#134). */
  setMessageCheckpoint(
    messageId: string,
    checkpoint: string,
  ): Promise<AppMessage | null>;
  /**
   * Flip a message's `dropped`/`removed` delivery flags (#315). Returns the
   * updated row for the `message.changed` broadcast, null when missing.
   */
  setMessageFlags(
    messageId: string,
    flags: { dropped?: boolean; removed?: boolean },
  ): Promise<AppMessage | null>;
  /**
   * Mark every message on the conversation with `seq >= fromSeq` as rewound
   * (#134): hidden from thread/summary reads, kept for audit. Returns the
   * messages it marked, oldest first.
   */
  markRewound(conversationId: string, fromSeq: number): Promise<AppMessage[]>;

  /**
   * Idempotent on (conversationId, requestId): re-opening the same engine
   * request returns the existing ask unchanged (the harness may re-open after
   * a reconnect replay).
   */
  createAsk(input: NewAsk): Promise<{ ask: Ask; created: boolean }>;
  getAsk(id: string): Promise<Ask | null>;
  resolveAsk(id: string, resolution: ResolveAskInput): Promise<Ask | null>;
  listAsks(query: ListAsksQuery): Promise<Ask[]>;

  /**
   * User messages past each conversation's `deliveredSeq` watermark — the
   * turns the engine host still owes. Surfaced by `harness.register`.
   */
  listPendingTurns(): Promise<PendingTurn[]>;

  /**
   * LilOS-owned key/value settings (#92): `settings.get` returns the stored
   * JSON value or null; `settings.set` upserts it. The Edit-models hide
   * list (`modelVisibility`) lives here — one list for the whole company.
   */
  getSetting(key: string): Promise<unknown | null>;
  setSetting(key: string, value: unknown): Promise<void>;

  /* ---------------------- phone pairing (#153) ------------------------ */
  /**
   * A pairing grant is stored only as a hash — the raw code exists in the QR
   * and the exchange request, never in the DB. `consumedAt` set = spent.
   */
  insertPairingGrant(grant: {
    codeHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  /**
   * Spend a grant atomically: marks it consumed when it is known, unexpired
   * (`expiresAt > at`) and unused; the failure string classifies the refusal
   * so the exchange endpoint can answer `unknown` | `expired` | `used`.
   */
  consumePairingGrant(
    codeHash: string,
    at: number,
  ): Promise<"ok" | "unknown" | "expired" | "used">;
  /**
   * Spend a grant AND record the new device in one transaction — a
   * device-insert failure rolls the spend back so the phone can retry the
   * same code instead of losing it to an opaque 500.
   */
  exchangePairingGrant(input: {
    codeHash: string;
    device: NewPairedDevice;
    at: number;
  }): Promise<
    { device: PairedDevice } | { error: "unknown" | "expired" | "used" }
  >;
  /** Drop spent/expired grant rows; called on every mint so the table stays small. */
  prunePairingGrants(at: number): Promise<void>;
  insertPairedDevice(device: NewPairedDevice): Promise<PairedDevice>;
  /**
   * Device-credential hello: a hash match on an unrevoked device bumps
   * `lastSeenAt` and returns the record; anything else returns null.
   */
  authenticateDevice(input: {
    deviceId: string;
    credentialHash: string;
    seenAt: number;
  }): Promise<PairedDevice | null>;
  listPairedDevices(): Promise<PairedDevice[]>;
  /** Mark revoked; returns the public record, null when unknown/already off.
      Also drops the device's push registration (#161 AC-1). */
  revokePairedDevice(
    id: string,
    revokedAt: number,
  ): Promise<PairedDevice | null>;

  /* ------------------------- push registration (#161) ----------------------- */

  /** Upsert a device's Expo push token + per-kind toggles (idempotent). */
  setDevicePush(input: {
    deviceId: string;
    token: string;
    prefs: PushPrefs;
    at: number;
  }): Promise<void>;
  /** Every phone still registered for pushes — the fan-out targets. */
  listDevicePush(): Promise<DevicePush[]>;
  /** Drop a registration (push.unregister, dead token, revoke). */
  dropDevicePush(deviceId: string): Promise<void>;
  /**
   * Engine-event freshness watermark (#161): records `seq` as the highest
   * engine-event seq the relay has seen for `sessionId` and answers whether
   * this call advanced it. A replayed `engine.event` (`seq` at/under the
   * stored mark) answers false so a relay or harness restart can't
   * re-notify an old transition. Persisted — an in-memory mark would let a
   * relay restart re-push.
   */
  advanceEngineEventSeq(input: {
    sessionId: string;
    seq: number;
    at: number;
  }): Promise<boolean>;
}

/** A phone's Expo push registration (#161), tied to its paired device id. */
export interface DevicePush {
  deviceId: string;
  token: string;
  prefs: PushPrefs;
  updatedAt: number;
}

/** A new paired device as written (credential arrives pre-hashed). */
export interface NewPairedDevice {
  id: string;
  name: string;
  credentialHash: string;
  pairedAt: number;
  lastSeenAt: number;
}

/** Row shape the store keeps internally (credential hash never leaves it). */
interface PairedDeviceRow extends NewPairedDevice {
  revokedAt?: number;
}

const rowToDevice = (row: PairedDeviceRow): PairedDevice => ({
  id: row.id,
  name: row.name,
  pairedAt: row.pairedAt,
  lastSeenAt: row.lastSeenAt,
});

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * The name a conversation wears before the engine titles it (#137 AC-3):
 * the first ~6 words / ~60 chars of the first message — the same rule
 * Synara uses — or `Image` for an image-only send. Collapses whitespace so
 * multi-line pastes read as one line.
 */
function placeholderTitle(text: string, hasAttachments: boolean): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return hasAttachments ? "Image" : "";
  const words = clean.split(" ");
  let title = words.slice(0, 6).join(" ");
  if (title.length > 60) {
    // Over-long first words: cut under 60 chars at a word boundary.
    const cut = title.slice(0, 59);
    const boundary = cut.lastIndexOf(" ");
    title = boundary > 0 ? cut.slice(0, boundary) : cut;
    return `${title}…`;
  }
  return words.length > 6 ? `${title}…` : title;
}

/** Resolve the title + provenance for a new conversation (#137). */
export function openTitle(input: OpenConversationInput): {
  title: string;
  titleSource: "auto" | "user";
} {
  if (input.title !== "") {
    // A title passed at open is a chosen name — user unless the engine
    // host itself opened the conversation.
    return { title: input.title, titleSource: input.titleSource ?? "user" };
  }
  return {
    title: placeholderTitle(input.text, (input.attachments?.length ?? 0) > 0),
    titleSource: "auto",
  };
}

/**
 * Fold title provenance into an update patch (#137 AC-2): an `auto` write
 * (engine host) applies only while the row isn't user-titled; a `user`
 * write always applies and marks the row user-named.
 */
export function titlePatch(
  patch: ConversationPatch,
  current: Conversation | { titleSource: "auto" | "user" },
): ConversationPatch {
  if (patch.title === undefined) return patch;
  const provenance = patch.titleSource ?? "user";
  if (provenance === "auto" && current.titleSource === "user") {
    // A late engine title never overwrites a rename.
    const { title: _title, titleSource: _ts, ...rest } = patch;
    return rest;
  }
  return { ...patch, titleSource: provenance };
}

/** Reference implementation used by unit tests; SQLite is the shipped one. */
export function createMemoryStore(): RelayStore {
  const employees = new Map<string, Employee>();
  const channels = new Map<string, AppChannel>();
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, AppMessage>();
  const asks = new Map<string, Ask>();
  const folders = new Map<string, RecentFolder>();
  const settings = new Map<string, unknown>();
  let profile: ProfileSettings = {};
  const grants = new Map<
    string,
    {
      codeHash: string;
      createdAt: number;
      expiresAt: number;
      consumedAt?: number;
    }
  >();
  const devices = new Map<string, PairedDeviceRow>();
  /** Expo push registrations by device id (#161). */
  const devicePush = new Map<string, DevicePush>();
  /** Highest engine-event seq seen per session — the replay fence (#161). */
  const engineEventSeqs = new Map<string, number>();
  /** (sessionId, seq) of the turn.completed that wrote each conversation's
      `usage` — the write fence (#300). */
  const turnUsageMarks = new Map<string, { sessionId: string; seq: number }>();

  /** Strictly increasing recents tick — survives same-ms calls in tests. */
  const folderTick = () =>
    Math.max(
      now(),
      Math.max(0, ...[...folders.values()].map((f) => f.lastUsedAt)) + 1,
    );
  const touchFolder = (path: string): RecentFolder => {
    const folder = { path, lastUsedAt: folderTick() };
    folders.set(path, folder);
    return folder;
  };

  const now = () => Date.now();
  /** (channelId, dedupeKey) -> stored message id; side table so the wire type stays clean. */
  const dedupe = new Map<string, string>();
  /** Ids of retired notes kept in storage but never read out (#196). */
  const hiddenIds = new Set<string>();
  const channelMessages = (channelId: string) =>
    [...messages.values()]
      .filter((m) => m.channelId === channelId && !hiddenIds.has(m.id))
      .sort((a, b) => a.seq - b.seq);

  const appendMessage = (
    input: AppendMessageInput,
  ): { message: AppMessage; created: boolean } => {
    const channel = channels.get(input.channelId);
    if (!channel) throw new Error(`unknown channel ${input.channelId}`);
    if (input.conversationId) {
      const conversation = conversations.get(input.conversationId);
      if (!conversation || conversation.channelId !== input.channelId) {
        throw new Error(`unknown conversation ${input.conversationId}`);
      }
    }
    if (input.dedupeKey) {
      const existingId = dedupe.get(`${input.channelId}|${input.dedupeKey}`);
      const existing = existingId ? messages.get(existingId) : undefined;
      if (existing) {
        if (noFolderDedupeKey(input.dedupeKey)) hiddenIds.add(existing.id);
        return { message: existing, created: false };
      }
    }
    const seq = channel.lastSeq + 1;
    channel.lastSeq = seq;
    const message: AppMessage = {
      id: newId("msg"),
      channelId: input.channelId,
      conversationId: input.conversationId ?? null,
      authorId: input.authorId,
      authorKind: input.authorKind,
      rewound: false,
      dropped: false,
      removed: false,
      text: input.text,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.fast !== undefined ? { fast: input.fast } : {}),
      seq,
      createdAt: now(),
      attachments: input.attachments,
    };
    messages.set(message.id, message);
    if (noFolderDedupeKey(input.dedupeKey)) hiddenIds.add(message.id);
    if (input.dedupeKey) {
      dedupe.set(`${input.channelId}|${input.dedupeKey}`, message.id);
    }
    return { message, created: true };
  };

  const conversationMessages = (conversationId: string) =>
    [...messages.values()]
      .filter(
        (m) => m.conversationId === conversationId && !hiddenIds.has(m.id),
      )
      .sort((a, b) => a.seq - b.seq);
  const visible = (list: AppMessage[]) => list.filter((m) => !m.rewound);

  return {
    async listEmployees() {
      return [...employees.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async getEmployee(id) {
      return employees.get(id) ?? null;
    },
    async createEmployee(input) {
      const employee: Employee = {
        id: newId("emp"),
        createdAt: now(),
        ...input,
      };
      employees.set(employee.id, employee);
      return employee;
    },
    async updateEmployee(id, patch) {
      const employee = employees.get(id);
      if (!employee) return null;
      Object.assign(employee, patch);
      return employee;
    },
    async removeEmployee(id) {
      const employee = employees.get(id);
      if (!employee) return null;
      const removedChannels = [...channels.values()].filter(
        (c) => c.employeeId === id,
      );
      const channelIds = new Set(removedChannels.map((c) => c.id));
      const conversationIds = new Set(
        [...conversations.values()]
          .filter((c) => channelIds.has(c.channelId))
          .map((c) => c.id),
      );
      for (const [aid, ask] of asks) {
        if (
          channelIds.has(ask.channelId) ||
          conversationIds.has(ask.conversationId)
        )
          asks.delete(aid);
      }
      for (const [mid, message] of messages) {
        if (channelIds.has(message.channelId)) messages.delete(mid);
      }
      for (const [cid, conversation] of conversations) {
        if (channelIds.has(conversation.channelId)) conversations.delete(cid);
      }
      for (const cid of channelIds) channels.delete(cid);
      employees.delete(id);
      return { employee, channelIds: [...channelIds] };
    },
    async listChannels() {
      return [...channels.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async getChannel(id) {
      return channels.get(id) ?? null;
    },
    async openDmChannel(employeeId) {
      const existing = [...channels.values()].find(
        (c) => c.kind === "dm" && c.employeeId === employeeId,
      );
      if (existing) return { channel: existing, created: false };
      const employee = employees.get(employeeId);
      if (!employee) throw new Error(`unknown employee ${employeeId}`);
      const channel: AppChannel = {
        id: newId("ch"),
        kind: "dm",
        employeeId,
        lastSeq: 0,
        createdAt: now(),
      };
      channels.set(channel.id, channel);
      return { channel, created: true };
    },
    async listConversations({ channelId, includeArchived }) {
      return [...conversations.values()]
        .filter((c) => (channelId ? c.channelId === channelId : true))
        .filter((c) => (includeArchived ? true : !c.archived))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async listRecentFolders() {
      return [...folders.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    },
    async addRecentFolder(path) {
      return touchFolder(path);
    },
    async getProfile() {
      return { ...profile };
    },
    async updateProfile(patch) {
      profile = { ...profile, ...patch };
      return { ...profile };
    },
    async getConversation(id) {
      return conversations.get(id) ?? null;
    },
    async listConversationSummaries({ channelId, includeArchived }) {
      const convs = [...conversations.values()]
        .filter((c) => (channelId ? c.channelId === channelId : true))
        .filter((c) => (includeArchived ? true : !c.archived))
        .sort((a, b) => a.createdAt - b.createdAt);
      const summaries: ConversationSummary[] = [];
      for (const conversation of convs) {
        const all = conversationMessages(conversation.id);
        const convMessages = visible(all);
        /* A rewind to the root message leaves zero visible messages — the
           list row still renders the (rewound) root for context. */
        const root =
          convMessages.find((m) => m.id === conversation.rootMessageId) ??
          all.find((m) => m.id === conversation.rootMessageId);
        const last = convMessages.at(-1) ?? all.at(-1);
        if (!root || !last) continue;
        summaries.push({
          conversation,
          root,
          firstAnswer: convMessages.find((m) => m.authorKind !== "user"),
          last,
          messageCount: convMessages.length,
        });
      }
      return summaries;
    },
    async openConversation(input) {
      const conversation: Conversation = {
        id: newId("conv"),
        channelId: input.channelId,
        rootMessageId: "",
        engineRef: null,
        state: "idle",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.workspace !== undefined
          ? { workspace: input.workspace }
          : {}),
        ...openTitle(input),
        archived: false,
        deliveredSeq: 0,
        createdAt: now(),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.fast !== undefined ? { fast: input.fast } : {}),
      };
      conversations.set(conversation.id, conversation);
      /* The picker's folder bumps recents — a `.lilos/wt/*` run dir never
         makes the list (#156). */
      const bump = input.workspace?.repoPath ?? input.cwd;
      if (bump !== undefined) touchFolder(bump);
      const { message: rootMessage } = appendMessage({
        channelId: input.channelId,
        conversationId: conversation.id,
        authorId: input.authorId,
        authorKind: "user",
        text: input.text,
        attachments: input.attachments,
      });
      conversation.rootMessageId = rootMessage.id;
      return { conversation, rootMessage };
    },
    async updateConversation(id, patch) {
      const conversation = conversations.get(id);
      if (!conversation) return null;
      patch = titlePatch(patch, conversation);
      // The delivery watermark only moves forward — a slower write must not
      // re-owe a later message its prompt.
      if (patch.deliveredSeq !== undefined) {
        patch.deliveredSeq = Math.max(
          conversation.deliveredSeq,
          patch.deliveredSeq,
        );
      }
      /* `null` in a patch clears an engine-pinned field (#92); the domain
         object holds `undefined`, never `null`. */
      for (const k of ["model", "provider", "effort", "fast"] as const) {
        if (patch[k] === null) {
          delete (conversation as Record<string, unknown>)[k];
          patch = { ...patch, [k]: undefined };
        }
      }
      Object.assign(conversation, patch);
      return conversation;
    },
    async recordTurnUsage({ conversationId, sessionId, seq, usage }) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return;
      const mark = turnUsageMarks.get(conversationId);
      if (mark && mark.sessionId === sessionId && seq <= mark.seq) return;
      turnUsageMarks.set(conversationId, { sessionId, seq });
      conversation.usage = usage;
    },
    async listMessages(
      channelId,
      { conversationId, afterSeq, limit, includeRewound, includeDropped },
    ) {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      let list = conversationId
        ? conversationMessages(conversationId)
        : channelMessages(channelId);
      /* Removed rows are gone from every read (#315); dropped ones hide by
         default too — only the not-sent tray asks for them. */
      list = list.filter((m) => !m.removed);
      if (!includeDropped) list = list.filter((m) => !m.dropped);
      if (!includeRewound) list = visible(list);
      if (afterSeq !== undefined) {
        list = list.filter((m) => m.seq > afterSeq);
        if (limit !== undefined) list = list.slice(0, limit);
      } else if (limit !== undefined) {
        list = list.slice(-limit);
      }
      return { messages: list, lastSeq: channel.lastSeq };
    },
    async searchMessages({ query, channelId, includeArchived, limit }) {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const hits: MessageSearchHit[] = [];
      for (const m of messages.values()) {
        if (hiddenIds.has(m.id)) continue;
        if (channelId && m.channelId !== channelId) continue;
        // Hidden messages don't surface as search hits (#134, #315).
        if (m.rewound || m.dropped || m.removed) continue;
        if (!includeArchived && m.conversationId) {
          const conversation = conversations.get(m.conversationId);
          if (conversation?.archived) continue;
        }
        if (!messageMatchesTerms(m.text, terms)) continue;
        hits.push({
          messageId: m.id,
          conversationId: m.conversationId,
          channelId: m.channelId,
          authorId: m.authorId,
          snippet: markSnippet(m.text, terms),
          createdAt: m.createdAt,
        });
      }
      // Newest-first standing in for relevance rank (see RelayStore docs).
      hits.sort((a, b) => b.createdAt - a.createdAt);
      return hits.slice(0, limit);
    },
    async appendMessage(input) {
      return appendMessage(input);
    },
    async getMessage(id) {
      return messages.get(id) ?? null;
    },
    async setMessageCheckpoint(messageId, checkpoint) {
      const message = messages.get(messageId);
      if (!message) return null;
      message.checkpoint = checkpoint;
      return message;
    },
    async setMessageFlags(messageId, flags) {
      const message = messages.get(messageId);
      if (!message) return null;
      if (flags.dropped !== undefined) message.dropped = flags.dropped;
      if (flags.removed !== undefined) message.removed = flags.removed;
      return message;
    },
    async markRewound(conversationId, fromSeq) {
      const marked: AppMessage[] = [];
      for (const m of conversationMessages(conversationId)) {
        if (m.seq >= fromSeq && !m.rewound) {
          m.rewound = true;
          marked.push(m);
        }
      }
      return marked;
    },
    async createAsk(input) {
      const existing = [...asks.values()].find(
        (a) =>
          a.conversationId === input.conversationId &&
          a.requestId === input.requestId,
      );
      if (existing) return { ask: existing, created: false };
      const ask: Ask = {
        id: newId("ask"),
        channelId: input.channelId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        requestId: input.requestId,
        request: input.request,
        state: "open",
        createdAt: now(),
      };
      asks.set(ask.id, ask);
      return { ask, created: true };
    },
    async getAsk(id) {
      return asks.get(id) ?? null;
    },
    async resolveAsk(id, resolution) {
      const ask = asks.get(id);
      if (!ask) return null;
      ask.state = "resolved";
      ask.outcome = resolution.outcome;
      ask.answer = resolution.answer;
      ask.resolvedAt = now();
      return ask;
    },
    async listAsks({ channelId, conversationId, state }) {
      return [...asks.values()]
        .filter((a) => (channelId ? a.channelId === channelId : true))
        .filter((a) =>
          conversationId ? a.conversationId === conversationId : true,
        )
        .filter((a) => (state ? a.state === state : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async listPendingTurns() {
      const pending: PendingTurn[] = [];
      for (const conversation of conversations.values()) {
        if (conversation.archived || conversation.state === "closed") continue;
        const channel = channels.get(conversation.channelId);
        if (!channel) continue;
        const owed = conversationMessages(conversation.id).filter(
          (m) =>
            m.authorKind === "user" &&
            !m.rewound &&
            !m.dropped &&
            !m.removed &&
            m.seq > conversation.deliveredSeq,
        );
        const message = owed.at(-1);
        if (message) {
          pending.push({ conversation, channel, message, messages: owed });
        }
      }
      pending.sort((a, b) => a.message.seq - b.message.seq);
      return pending;
    },
    async getSetting(key) {
      return settings.has(key) ? (settings.get(key) as unknown) : null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
    async insertPairingGrant(grant) {
      grants.set(grant.codeHash, { ...grant });
    },
    async consumePairingGrant(codeHash, at) {
      const grant = grants.get(codeHash);
      if (!grant) return "unknown";
      if (grant.consumedAt !== undefined) return "used";
      if (grant.expiresAt <= at) return "expired";
      grant.consumedAt = at;
      return "ok";
    },
    async exchangePairingGrant({ codeHash, device, at }) {
      /* Single-threaded map ops are already atomic — same verdicts as the
         drizzle transaction. */
      const grant = grants.get(codeHash);
      if (!grant) return { error: "unknown" as const };
      if (grant.consumedAt !== undefined) return { error: "used" as const };
      if (grant.expiresAt <= at) return { error: "expired" as const };
      grant.consumedAt = at;
      devices.set(device.id, { ...device });
      return { device: rowToDevice(device) };
    },
    async prunePairingGrants(at) {
      for (const [codeHash, grant] of grants) {
        if (grant.consumedAt !== undefined || grant.expiresAt <= at) {
          grants.delete(codeHash);
        }
      }
    },
    async insertPairedDevice(device) {
      devices.set(device.id, { ...device });
      return rowToDevice(device);
    },
    async authenticateDevice({ deviceId, credentialHash, seenAt }) {
      const device = devices.get(deviceId);
      if (!device || device.revokedAt !== undefined) return null;
      if (device.credentialHash !== credentialHash) return null;
      device.lastSeenAt = seenAt;
      return rowToDevice(device);
    },
    async listPairedDevices() {
      return [...devices.values()]
        .filter((d) => d.revokedAt === undefined)
        .map(rowToDevice)
        .sort((a, b) => a.pairedAt - b.pairedAt);
    },
    async revokePairedDevice(id, revokedAt) {
      const device = devices.get(id);
      if (!device || device.revokedAt !== undefined) return null;
      device.revokedAt = revokedAt;
      devicePush.delete(id);
      return rowToDevice(device);
    },
    async setDevicePush(input) {
      devicePush.set(input.deviceId, {
        deviceId: input.deviceId,
        token: input.token,
        prefs: input.prefs,
        updatedAt: input.at,
      });
    },
    async listDevicePush() {
      return [...devicePush.values()].map((d) => ({ ...d }));
    },
    async dropDevicePush(deviceId) {
      devicePush.delete(deviceId);
    },
    async advanceEngineEventSeq({ sessionId, seq }) {
      const last = engineEventSeqs.get(sessionId) ?? 0;
      if (seq <= last) return false;
      engineEventSeqs.set(sessionId, seq);
      return true;
    },
  };
}
