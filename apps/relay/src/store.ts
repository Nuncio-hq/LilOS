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
  PendingTurn,
  RecentFolder,
  RespondTo,
} from "@lilos/contracts/app";
import type { ApprovalOutcome, EngineRequest } from "@lilos/contracts/engine";

export interface NewEmployee {
  name: string;
  role: string;
  status: EmployeeStatus;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
}

export type EmployeePatchInput = Partial<NewEmployee>;

export interface ConversationPatch {
  title?: string;
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
  title: string;
  text: string;
  authorId: string;
  /** Display refs only — bytes already stored via the AttachmentStore. */
  attachments?: MessageAttachment[];
  /** The composer's pick stamped at open (#92) — `session.start` applies it. */
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Folder the session works in (#113); also bumps the recents list. */
  cwd?: string;
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
}

export interface ListMessagesPage {
  messages: AppMessage[];
  lastSeq: number;
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

  listMessages(
    channelId: string,
    query: ListMessagesQuery,
  ): Promise<ListMessagesPage>;
  /**
   * Appends with the channel's next seq (atomic with the counter bump).
   * `dedupeKey` makes the write idempotent: `created: false` returns the
   * message the first call stored.
   */
  appendMessage(
    input: AppendMessageInput,
  ): Promise<{ message: AppMessage; created: boolean }>;

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
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
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
  const channelMessages = (channelId: string) =>
    [...messages.values()]
      .filter((m) => m.channelId === channelId)
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
      if (existing) return { message: existing, created: false };
    }
    const seq = channel.lastSeq + 1;
    channel.lastSeq = seq;
    const message: AppMessage = {
      id: newId("msg"),
      channelId: input.channelId,
      conversationId: input.conversationId ?? null,
      authorId: input.authorId,
      authorKind: input.authorKind,
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
    if (input.dedupeKey) {
      dedupe.set(`${input.channelId}|${input.dedupeKey}`, message.id);
    }
    return { message, created: true };
  };

  const conversationMessages = (conversationId: string) =>
    [...messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.seq - b.seq);

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
        const convMessages = conversationMessages(conversation.id);
        const root = convMessages.find(
          (m) => m.id === conversation.rootMessageId,
        );
        const last = convMessages.at(-1);
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
        title: input.title,
        archived: false,
        deliveredSeq: 0,
        createdAt: now(),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.fast !== undefined ? { fast: input.fast } : {}),
      };
      conversations.set(conversation.id, conversation);
      if (input.cwd !== undefined) touchFolder(input.cwd);
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
    async listMessages(channelId, { conversationId, afterSeq, limit }) {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      let list = conversationId
        ? conversationMessages(conversationId)
        : channelMessages(channelId);
      if (afterSeq !== undefined) {
        list = list.filter((m) => m.seq > afterSeq);
        if (limit !== undefined) list = list.slice(0, limit);
      } else if (limit !== undefined) {
        list = list.slice(-limit);
      }
      return { messages: list, lastSeq: channel.lastSeq };
    },
    async appendMessage(input) {
      return appendMessage(input);
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
          (m) => m.authorKind === "user" && m.seq > conversation.deliveredSeq,
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
  };
}
