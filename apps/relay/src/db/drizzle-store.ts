import type {
  AppChannel,
  AppMessage,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  AppendMessageInput,
  ConversationPatch,
  ListConversationsQuery,
  ListMessagesPage,
  ListMessagesQuery,
  OpenConversationInput,
  RelayStore,
} from "../store";
import { newId } from "../store";
import * as schema from "./schema";

type Db = BunSQLiteDatabase<typeof schema>;

export function createDrizzleStore(db: Db): RelayStore {
  const now = () => Date.now();

  const appendMessageTx = (input: AppendMessageInput): AppMessage => {
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
    const message: AppMessage = {
      id: newId("msg"),
      channelId: input.channelId,
      conversationId: input.conversationId ?? null,
      authorId: input.authorId,
      authorKind: input.authorKind,
      text: input.text,
      seq: bumped.seq,
      createdAt: now(),
    };
    db.insert(schema.messages).values(message).run();
    return message;
  };

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
      if (existing) return existing;
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
        // Another insert won the get-or-create race; return it.
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
        return raced;
      }
      return channel;
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
      return rows;
    },
    async getConversation(id) {
      return (
        db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id))
          .get() ?? null
      );
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
        };
        // conversations.rootMessageId ↔ messages.conversationId are mutually
        // dependent FKs: insert the message unattributed, then the
        // conversation, then point the message at it — one transaction.
        tx.insert(schema.messages)
          .values({ ...rootMessage, conversationId: null })
          .run();
        const conversation: Conversation = {
          id: conversationId,
          channelId: input.channelId,
          rootMessageId: rootMessage.id,
          engineRef: null,
          state: "idle",
          title: input.title,
          archived: false,
          createdAt: now(),
        };
        tx.insert(schema.conversations).values(conversation).run();
        tx.update(schema.messages)
          .set({ conversationId })
          .where(eq(schema.messages.id, rootMessage.id))
          .run();
        return { conversation, rootMessage };
      });
    },
    async updateConversation(id, patch: ConversationPatch) {
      const updated = db
        .update(schema.conversations)
        .set(patch)
        .where(eq(schema.conversations.id, id))
        .returning()
        .get();
      return updated ?? null;
    },
    async listMessages(
      channelId: string,
      { afterSeq, limit }: ListMessagesQuery,
    ): Promise<ListMessagesPage> {
      const channel = db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
        .get();
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      const rows =
        afterSeq !== undefined
          ? db
              .select()
              .from(schema.messages)
              .where(
                and(
                  eq(schema.messages.channelId, channelId),
                  gt(schema.messages.seq, afterSeq),
                ),
              )
              .orderBy(asc(schema.messages.seq))
              .limit(limit ?? -1)
              .all()
          : db
              .select()
              .from(schema.messages)
              .where(eq(schema.messages.channelId, channelId))
              .orderBy(desc(schema.messages.seq))
              .limit(limit ?? -1)
              .all()
              .reverse();
      return { messages: rows, lastSeq: channel.lastSeq };
    },
    async appendMessage(input) {
      return db.transaction(() => appendMessageTx(input));
    },
  };
}
