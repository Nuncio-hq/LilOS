import type {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
  MessageAttachment,
  PendingTurn,
  ProfileSettings,
  RecentFolder,
} from "@lilos/contracts/app";
import { ApprovalOutcome, EngineRequest } from "@lilos/contracts/engine";
import { and, asc, desc, eq, gt, inArray, max, ne, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  AppendMessageInput,
  ConversationPatch,
  ListAsksQuery,
  ListConversationsQuery,
  ListMessagesPage,
  ListMessagesQuery,
  NewAsk,
  OpenConversationInput,
  RelayStore,
  ResolveAskInput,
} from "../store";
import { newId, openTitle, searchTerms, titlePatch } from "../store";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

type ConversationRow = typeof schema.conversations.$inferSelect;
/* SQLite columns are NULL when unset; the contract field is optional, not
   nullable — fold null to absent at the boundary. */
const rowToConversation = (row: ConversationRow): Conversation => ({
  ...row,
  model: row.model ?? undefined,
  provider: row.provider ?? undefined,
  effort: row.effort ?? undefined,
  fast: row.fast ?? undefined,
  cwd: row.cwd ?? undefined,
});

type MessageRow = typeof schema.messages.$inferSelect;
/** Rows carry attachment refs as JSON text; the domain object unpacks them. */
const rowToMessage = (row: MessageRow): AppMessage => ({
  ...row,
  model: row.model ?? undefined,
  provider: row.provider ?? undefined,
  effort: row.effort ?? undefined,
  fast: row.fast ?? undefined,
  attachments: row.attachments
    ? (JSON.parse(row.attachments) as MessageAttachment[])
    : undefined,
});
const messageToRow = (message: AppMessage) => ({
  ...message,
  attachments: message.attachments?.length
    ? JSON.stringify(message.attachments)
    : null,
});

type AskRow = typeof schema.asks.$inferSelect;
const rowToAsk = (row: AskRow): Ask => ({
  id: row.id,
  channelId: row.channelId,
  conversationId: row.conversationId,
  turnId: row.turnId,
  requestId: row.requestId,
  request: EngineRequest.parse(JSON.parse(row.request)),
  state: row.state,
  outcome: ApprovalOutcome.optional().parse(row.outcome ?? undefined),
  answer: row.answer ?? undefined,
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt ?? undefined,
});

type ProfileRow = typeof schema.profile.$inferSelect;
const rowToProfile = (row: ProfileRow): ProfileSettings => ({
  userName: row.userName ?? undefined,
  companyName: row.companyName ?? undefined,
  avatarColor: row.avatarColor ?? undefined,
});

export function createDrizzleStore(db: Db): RelayStore {
  const now = () => Date.now();

  /* Monotonic recents tick (#113): newest-first ordering stays stable even
     when two picks land inside the same millisecond. `q` is the db or its
     sync transaction handle (both run `.get()` synchronously). */
  const nextFolderStamp = (q: { select: Db["select"] }): number => {
    const top = q
      .select({ m: max(schema.recentFolders.lastUsedAt) })
      .from(schema.recentFolders)
      .get();
    return Math.max(now(), (top?.m ?? 0) + 1);
  };

  const appendMessageTx = (
    input: AppendMessageInput,
  ): { message: AppMessage; created: boolean } => {
    if (input.dedupeKey) {
      const existing = db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.channelId, input.channelId),
            eq(schema.messages.dedupeKey, input.dedupeKey),
          ),
        )
        .get();
      if (existing) return { message: rowToMessage(existing), created: false };
    }
    const bumped = db
      .update(schema.channels)
      .set({ lastSeq: sql`${schema.channels.lastSeq} + 1` })
      .where(eq(schema.channels.id, input.channelId))
      .returning({ seq: schema.channels.lastSeq })
      .get();
    if (!bumped) throw new Error(`unknown channel ${input.channelId}`);
    if (input.conversationId) {
      const conversation = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, input.conversationId))
        .get();
      if (!conversation || conversation.channelId !== input.channelId) {
        throw new Error(`unknown conversation ${input.conversationId}`);
      }
    }
    const message = {
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
      dedupeKey: input.dedupeKey ?? null,
      seq: bumped.seq,
      createdAt: now(),
      attachments: input.attachments,
    };
    db.insert(schema.messages).values(messageToRow(message)).run();
    const { dedupeKey: _dedupeKey, ...appMessage } = message;
    return { message: appMessage, created: true };
  };

  const conversationMessages = (conversationId: string) =>
    db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.seq))
      .all();

  return {
    async listEmployees() {
      return db
        .select()
        .from(schema.employees)
        .orderBy(asc(schema.employees.createdAt))
        .all();
    },
    async getEmployee(id) {
      return (
        db
          .select()
          .from(schema.employees)
          .where(eq(schema.employees.id, id))
          .get() ?? null
      );
    },
    async createEmployee(input) {
      const employee: Employee = {
        id: newId("emp"),
        createdAt: now(),
        ...input,
      };
      db.insert(schema.employees).values(employee).run();
      return employee;
    },
    async updateEmployee(id, patch) {
      const updated = db
        .update(schema.employees)
        .set(patch)
        .where(eq(schema.employees.id, id))
        .returning()
        .get();
      return updated ?? null;
    },
    async removeEmployee(id) {
      return db.transaction((tx) => {
        const employee = tx
          .select()
          .from(schema.employees)
          .where(eq(schema.employees.id, id))
          .get();
        if (!employee) return null;
        const channelIds = tx
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(eq(schema.channels.employeeId, id))
          .all()
          .map((r) => r.id);
        if (channelIds.length > 0) {
          // conversations.rootMessageId ↔ messages.conversationId are mutual
          // FKs (openConversation mirrors this order on insert): detach
          // messages from their conversations, then delete conversations,
          // then the now-free messages.
          tx.update(schema.messages)
            .set({ conversationId: null })
            .where(inArray(schema.messages.channelId, channelIds))
            .run();
          tx.delete(schema.asks)
            .where(inArray(schema.asks.channelId, channelIds))
            .run();
          tx.delete(schema.conversations)
            .where(inArray(schema.conversations.channelId, channelIds))
            .run();
          tx.delete(schema.messages)
            .where(inArray(schema.messages.channelId, channelIds))
            .run();
          tx.delete(schema.channels)
            .where(inArray(schema.channels.id, channelIds))
            .run();
        }
        tx.delete(schema.employees).where(eq(schema.employees.id, id)).run();
        return { employee, channelIds };
      });
    },
    async listChannels() {
      return db
        .select()
        .from(schema.channels)
        .orderBy(asc(schema.channels.createdAt))
        .all();
    },
    async getChannel(id) {
      return (
        db
          .select()
          .from(schema.channels)
          .where(eq(schema.channels.id, id))
          .get() ?? null
      );
    },
    async openDmChannel(employeeId) {
      const existing = db
        .select()
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.kind, "dm"),
            eq(schema.channels.employeeId, employeeId),
          ),
        )
        .get();
      if (existing) return { channel: existing, created: false };
      const employee = db
        .select()
        .from(schema.employees)
        .where(eq(schema.employees.id, employeeId))
        .get();
      if (!employee) throw new Error(`unknown employee ${employeeId}`);
      const channel: AppChannel = {
        id: newId("ch"),
        kind: "dm",
        employeeId,
        lastSeq: 0,
        createdAt: now(),
      };
      try {
        db.insert(schema.channels).values(channel).run();
      } catch {
        // Another insert won the get-or-create race; return it — and let the
        // winner own the `channel.created` broadcast (created: false here).
        const raced = db
          .select()
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.kind, "dm"),
              eq(schema.channels.employeeId, employeeId),
            ),
          )
          .get();
        if (!raced) throw new Error(`openDmChannel failed for ${employeeId}`);
        return { channel: raced, created: false };
      }
      return { channel, created: true };
    },
    async listConversations({
      channelId,
      includeArchived,
    }: ListConversationsQuery) {
      const conditions = [];
      if (channelId)
        conditions.push(eq(schema.conversations.channelId, channelId));
      if (!includeArchived)
        conditions.push(eq(schema.conversations.archived, false));
      const base = db.select().from(schema.conversations);
      const rows = conditions.length
        ? base
            .where(and(...conditions))
            .orderBy(asc(schema.conversations.createdAt))
            .all()
        : base.orderBy(asc(schema.conversations.createdAt)).all();
      return rows.map(rowToConversation);
    },
    async getConversation(id) {
      const row = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .get();
      return row ? rowToConversation(row) : null;
    },
    async listConversationSummaries({
      channelId,
      includeArchived,
    }: ListConversationsQuery) {
      const convs = await this.listConversations({
        channelId,
        includeArchived,
      });
      const summaries: ConversationSummary[] = [];
      for (const conversation of convs) {
        const convMessages = conversationMessages(conversation.id).map(
          rowToMessage,
        );
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
    async listRecentFolders(): Promise<RecentFolder[]> {
      return db
        .select()
        .from(schema.recentFolders)
        .orderBy(
          desc(schema.recentFolders.lastUsedAt),
          desc(schema.recentFolders.path),
        )
        .all();
    },
    async addRecentFolder(path: string): Promise<RecentFolder> {
      const folder = { path, lastUsedAt: nextFolderStamp(db) };
      db.insert(schema.recentFolders)
        .values(folder)
        .onConflictDoUpdate({
          target: schema.recentFolders.path,
          set: { lastUsedAt: folder.lastUsedAt },
        })
        .run();
      return folder;
    },
    async getProfile(): Promise<ProfileSettings> {
      const row = db
        .select()
        .from(schema.profile)
        .where(eq(schema.profile.id, 1))
        .get();
      return row ? rowToProfile(row) : {};
    },
    async updateProfile(patch: ProfileSettings): Promise<ProfileSettings> {
      const cols: Partial<typeof schema.profile.$inferInsert> = {};
      if (patch.userName !== undefined) cols.userName = patch.userName;
      if (patch.companyName !== undefined) cols.companyName = patch.companyName;
      if (patch.avatarColor !== undefined) cols.avatarColor = patch.avatarColor;
      db.insert(schema.profile)
        .values({ id: 1, ...cols })
        .onConflictDoUpdate({ target: schema.profile.id, set: cols })
        .run();
      return this.getProfile();
    },
    async openConversation(input: OpenConversationInput) {
      return db.transaction((tx) => {
        const conversationId = newId("conv");
        const bumped = tx
          .update(schema.channels)
          .set({ lastSeq: sql`${schema.channels.lastSeq} + 1` })
          .where(eq(schema.channels.id, input.channelId))
          .returning({ seq: schema.channels.lastSeq })
          .get();
        if (!bumped) throw new Error(`unknown channel ${input.channelId}`);
        const rootMessage: AppMessage = {
          id: newId("msg"),
          channelId: input.channelId,
          conversationId,
          authorId: input.authorId,
          authorKind: "user",
          text: input.text,
          seq: bumped.seq,
          createdAt: now(),
          attachments: input.attachments,
        };
        // conversations.rootMessageId ↔ messages.conversationId are mutually
        // dependent FKs: insert the message unattributed, then the
        // conversation, then point the message at it — one transaction.
        tx.insert(schema.messages)
          .values({ ...messageToRow(rootMessage), conversationId: null })
          .run();
        const conversation: Conversation = {
          id: conversationId,
          channelId: input.channelId,
          rootMessageId: rootMessage.id,
          engineRef: null,
          state: "idle",
          ...openTitle(input),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          archived: false,
          deliveredSeq: 0,
          createdAt: now(),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
          ...(input.fast !== undefined ? { fast: input.fast } : {}),
        };
        tx.insert(schema.conversations).values(conversation).run();
        if (input.cwd !== undefined) {
          const stamp = nextFolderStamp(tx);
          tx.insert(schema.recentFolders)
            .values({ path: input.cwd, lastUsedAt: stamp })
            .onConflictDoUpdate({
              target: schema.recentFolders.path,
              set: { lastUsedAt: stamp },
            })
            .run();
        }
        tx.update(schema.messages)
          .set({ conversationId })
          .where(eq(schema.messages.id, rootMessage.id))
          .run();
        return { conversation, rootMessage };
      });
    },
    async updateConversation(id, patch: ConversationPatch) {
      // One read guards both conditional writes: the forward-only
      // deliveredSeq clamp and the title provenance rule (#137).
      if (patch.deliveredSeq !== undefined || patch.title !== undefined) {
        const current = db
          .select({
            deliveredSeq: schema.conversations.deliveredSeq,
            titleSource: schema.conversations.titleSource,
          })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id))
          .get();
        if (!current) return null;
        patch = titlePatch(patch, current);
        if (patch.deliveredSeq !== undefined) {
          patch = {
            ...patch,
            deliveredSeq: Math.max(current.deliveredSeq, patch.deliveredSeq),
          };
        }
        if (Object.keys(patch).length === 0) {
          // A title-only write dropped by the provenance rule (#137) is a
          // no-op: answer with the current row rather than `set({})`.
          return this.getConversation(id);
        }
      }
      const updated = db
        .update(schema.conversations)
        .set(patch)
        .where(eq(schema.conversations.id, id))
        .returning()
        .get();
      return updated ? rowToConversation(updated) : null;
    },
    async listMessages(
      channelId: string,
      { conversationId, afterSeq, limit }: ListMessagesQuery,
    ): Promise<ListMessagesPage> {
      const channel = db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
        .get();
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      const scope = conversationId
        ? and(
            eq(schema.messages.channelId, channelId),
            eq(schema.messages.conversationId, conversationId),
          )
        : eq(schema.messages.channelId, channelId);
      const rows =
        afterSeq !== undefined
          ? db
              .select()
              .from(schema.messages)
              .where(and(scope, gt(schema.messages.seq, afterSeq)))
              .orderBy(asc(schema.messages.seq))
              .limit(limit ?? -1)
              .all()
          : db
              .select()
              .from(schema.messages)
              .where(scope)
              .orderBy(desc(schema.messages.seq))
              .limit(limit ?? -1)
              .all()
              .reverse();
      return { messages: rows.map(rowToMessage), lastSeq: channel.lastSeq };
    },
    /* #138: FTS5 over the messages_fts external-content index (migration v9
       keeps it in sync via triggers). Terms are AND'd double-quoted tokens —
       quoting also neutralizes FTS syntax in the input; the last term gets
       `*` so the box can filter while the user is mid-word. The snippet is
       excerpted by SQLite with `<mark>` around each matched token. */
    async searchMessages({ query, channelId, includeArchived, limit }) {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const match = terms
        .map(
          (t, i) =>
            `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`,
        )
        .join(" AND ");
      return db.all<{
        messageId: string;
        conversationId: string | null;
        channelId: string;
        authorId: string;
        snippet: string;
        createdAt: number;
      }>(sql`
        SELECT m.id AS messageId,
               m.conversation_id AS conversationId,
               m.channel_id AS channelId,
               m.author_id AS authorId,
               snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
               m.created_at AS createdAt
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ${match}
          ${channelId ? sql`AND m.channel_id = ${channelId}` : sql``}
          ${includeArchived ? sql`` : sql`AND (c.id IS NULL OR c.archived = 0)`}
        ORDER BY bm25(messages_fts), m.created_at DESC
        LIMIT ${limit}
      `);
    },
    async appendMessage(input) {
      return db.transaction(() => appendMessageTx(input));
    },
    async createAsk(input: NewAsk) {
      const existing = db
        .select()
        .from(schema.asks)
        .where(
          and(
            eq(schema.asks.conversationId, input.conversationId),
            eq(schema.asks.requestId, input.requestId),
          ),
        )
        .get();
      if (existing) return { ask: rowToAsk(existing), created: false };
      const row: AskRow = {
        id: newId("ask"),
        channelId: input.channelId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        requestId: input.requestId,
        request: JSON.stringify(input.request),
        state: "open",
        outcome: null,
        answer: null,
        createdAt: now(),
        resolvedAt: null,
      };
      db.insert(schema.asks).values(row).run();
      return { ask: rowToAsk(row), created: true };
    },
    async getAsk(id) {
      const row = db
        .select()
        .from(schema.asks)
        .where(eq(schema.asks.id, id))
        .get();
      return row ? rowToAsk(row) : null;
    },
    async resolveAsk(id, resolution: ResolveAskInput) {
      const updated = db
        .update(schema.asks)
        .set({
          state: "resolved",
          outcome: resolution.outcome,
          answer: resolution.answer ?? null,
          resolvedAt: now(),
        })
        .where(eq(schema.asks.id, id))
        .returning()
        .get();
      return updated ? rowToAsk(updated) : null;
    },
    async listAsks({ channelId, conversationId, state }: ListAsksQuery) {
      const conditions = [];
      if (channelId) conditions.push(eq(schema.asks.channelId, channelId));
      if (conversationId)
        conditions.push(eq(schema.asks.conversationId, conversationId));
      if (state) conditions.push(eq(schema.asks.state, state));
      const base = db.select().from(schema.asks);
      const rows = conditions.length
        ? base
            .where(and(...conditions))
            .orderBy(asc(schema.asks.createdAt))
            .all()
        : base.orderBy(asc(schema.asks.createdAt)).all();
      return rows.map(rowToAsk);
    },
    async getSetting(key: string) {
      const row = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
      if (!row) return null;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return row.value;
      }
    },
    async setSetting(key: string, value: unknown) {
      const serialized = JSON.stringify(value);
      db.insert(schema.settings)
        .values({ key, value: serialized })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: serialized },
        })
        .run();
    },
    async listPendingTurns(): Promise<PendingTurn[]> {
      const convs = db
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.archived, false),
            ne(schema.conversations.state, "closed"),
          ),
        )
        .all();
      const pending: PendingTurn[] = [];
      for (const conversation of convs) {
        const owed = conversationMessages(conversation.id)
          .map(rowToMessage)
          .filter(
            (m) => m.authorKind === "user" && m.seq > conversation.deliveredSeq,
          );
        const message = owed.at(-1);
        if (!message) continue;
        const channel = db
          .select()
          .from(schema.channels)
          .where(eq(schema.channels.id, conversation.channelId))
          .get();
        if (!channel) continue;
        pending.push({
          conversation: rowToConversation(conversation),
          channel,
          message,
          messages: owed,
        });
      }
      pending.sort((a, b) => a.message.seq - b.message.seq);
      return pending;
    },
  };
}
