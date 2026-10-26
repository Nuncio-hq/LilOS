import type { Database } from "bun:sqlite";
import type {
  AppChannel,
  AppMessage,
  Ask,
  CompanyUpdate,
  Conversation,
  ConversationSummary,
  Employee,
  Goal,
  MessageAttachment,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  Project,
  PushPrefs,
  RecentFolder,
  ScheduledRunRecord,
  ScheduledTask,
  TaskSchedule,
  Ticket,
  TurnFailure,
  WorkspaceIntent,
} from "@lilos/contracts/app";
import {
  AskHireProposal,
  assertReportsAcyclic,
  CEO_SETTING_KEY,
  reportsToAfterCeo,
  type TaskWakeEvent,
  TicketResult,
  TicketStatus,
  TicketStep,
  TicketTask,
  TicketWaitingOn,
  toSummaryMessage,
  toSummaryPreview,
  withReportsTo,
} from "@lilos/contracts/app";
import { equalSecret } from "@lilos/contracts/auth";
import {
  ApprovalOutcome,
  EngineRequest,
  type Usage,
} from "@lilos/contracts/engine";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  AppendMessageInput,
  ConversationPatch,
  DevicePush,
  ListAsksQuery,
  ListConversationsQuery,
  ListMessagesPage,
  ListMessagesQuery,
  NewAsk,
  NewGoal,
  NewPairedDevice,
  NewProject,
  NewScheduledTask,
  NewTask,
  NewTicket,
  OpenConversationInput,
  RelayStore,
  ResolveAskInput,
  ScheduledTaskPatch,
  TicketPatch,
} from "../store";
import {
  deriveProjectKey,
  NO_FOLDER_DEDUPE_LIKE,
  newId,
  noFolderDedupeKey,
  openTitle,
  projectNameFor,
  searchTerms,
  titlePatch,
} from "../store";
import {
  applyWrite,
  checkout,
  commentUpdate,
  finish,
  initialStatus,
  parseUpdates,
  wakeWaiter,
  withUpdate,
} from "../work";
import * as schema from "./schema";

/* The drizzle handle keeps a typed `$client` back-reference to the raw
   bun:sqlite Database — #571's summary path needs its multi-statement SQL
   (grouped aggregates + row-value seeks) which the query builder can't
   express. */
type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

type ConversationRow = typeof schema.conversations.$inferSelect;
/* SQLite columns are NULL when unset; the contract field is optional, not
   nullable — fold null to absent at the boundary. The (sessionId, seq)
   usage fence columns are store-internal (#300) — never on the wire. */
const rowToConversation = (row: ConversationRow): Conversation => {
  const {
    usageSessionId: _sid,
    usageSeq: _seq,
    finishedSessionId: _fsid,
    finishedEventSeq: _fseq,
    stuckAt,
    ceoThread,
    ...rest
  } = row;
  return {
    ...rest,
    /* D-#777: the column is 0/1. The contract is literal true, so a
       false must not cross the wire. */
    ...(ceoThread ? { ceoThread: true as const } : {}),
    /* Issue #775: NULL means never stuck. The contract field is optional,
       not nullable — a null on the wire would fail the conversation parse. */
    ...(stuckAt != null ? { stuckAt } : {}),
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    effort: row.effort ?? undefined,
    fast: row.fast ?? undefined,
    cwd: row.cwd ?? undefined,
    projectId: row.projectId ?? undefined,
    ticketId: row.ticketId ?? undefined,
    /* D-#844: the creating thread's lineage — absent on a non-child. */
    parentId: row.parentId ?? undefined,
    /* JSON workstream pick (#156); rows opened before v13 have no column
       value — absent, not null. */
    workspace: row.workspace
      ? (JSON.parse(row.workspace) as WorkspaceIntent)
      : undefined,
    usage: row.usage ? (JSON.parse(row.usage) as Usage) : undefined,
    life: row.life ?? undefined,
    /* JSON TurnFailure (#419); absent on rows that never failed. */
    turnFailure: row.turnFailure
      ? (JSON.parse(row.turnFailure) as TurnFailure)
      : undefined,
    turnStopped: row.turnStopped ?? undefined,
    bgJobs: row.bgJobs ?? undefined,
    /* JSON `{reason}` (D-#772); absent when the turn isn't stuck. */
    stuck: row.stuck
      ? (JSON.parse(row.stuck) as Conversation["stuck"])
      : undefined,
    /* JSON {taskId, name} — set on sessions a scheduled task opened. */
    scheduled: row.scheduled
      ? (JSON.parse(row.scheduled) as Conversation["scheduled"])
      : undefined,
    /* D-#862: thread parking — epoch-ms stamps fold to absent; `settledPr`
       is its JSON {num, state}; `autoSettle` emits only when off (absent =
       on, the wire's default). `archived` rides the column — the mirror is
       maintained on every settle write. */
    pinnedAt: row.pinnedAt ?? undefined,
    settledAt: row.settledAt ?? undefined,
    settledReason: row.settledReason ?? undefined,
    settledPr: row.settledPr
      ? (JSON.parse(row.settledPr) as Conversation["settledPr"])
      : undefined,
    snoozedUntil: row.snoozedUntil ?? undefined,
    ...(row.autoSettle === false ? { autoSettle: false } : {}),
  };
};

type EmployeeRow = typeof schema.employees.$inferSelect;
/* SQLite NULL means "reports to the owner" (D-#775). The contract field is
   optional, not nullable — fold null to absent at the boundary, the same
   way a conversation's projectId is folded. */
const rowToEmployee = (row: EmployeeRow): Employee => {
  const { reportsTo, runtime, ...rest } = row;
  /* NULL folds to absent at the boundary — the contract fields are
     optional, not nullable (runtime = the default engine, D-#761). */
  return {
    ...rest,
    ...(reportsTo ? { reportsTo } : {}),
    ...(runtime ? { runtime } : {}),
  };
};

type ScheduledTaskRow = typeof schema.scheduledTasks.$inferSelect;
const rowToScheduledTask = (row: ScheduledTaskRow): ScheduledTask => ({
  id: row.id,
  employeeId: row.employeeId,
  name: row.name,
  prompt: row.prompt,
  folder: row.folder ?? undefined,
  schedule: JSON.parse(row.schedule) as TaskSchedule,
  access: row.access,
  paused: row.paused || undefined,
  lastFiredAt: row.lastFiredAt ?? undefined,
  requestedAt: row.requestedAt ?? undefined,
  lastRun: row.lastRun
    ? (JSON.parse(row.lastRun) as ScheduledRunRecord)
    : undefined,
  skippedAt: row.skippedAt ?? undefined,
  createdAt: row.createdAt,
});

type MessageRow = typeof schema.messages.$inferSelect;
/** Rows carry attachment refs as JSON text; the domain object unpacks them. */
const rowToMessage = (row: MessageRow): AppMessage => {
  const { ceoWake, taskWake, ...rest } = row;
  return {
    ...rest,
    /* D-#777: omit the flag unless this row is a wake. `false` would
       fail the literal-true contract. Same for D-#844's task wake. */
    ...(ceoWake ? { ceoWake: true as const } : {}),
    ...(taskWake ? { taskWake: true as const } : {}),
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    effort: row.effort ?? undefined,
    fast: row.fast ?? undefined,
    checkpoint: row.checkpoint ?? undefined,
    attachments: row.attachments
      ? (JSON.parse(row.attachments) as MessageAttachment[])
      : undefined,
  };
};
const messageToRow = (message: AppMessage & { dedupeKey?: string | null }) => {
  const { ceoWake, taskWake, ...rest } = message;
  return {
    ...rest,
    ceoWake: ceoWake === true,
    taskWake: taskWake === true,
    attachments: message.attachments?.length
      ? JSON.stringify(message.attachments)
      : null,
  };
};

type AskRow = typeof schema.asks.$inferSelect;
const rowToAsk = (row: AskRow): Ask => ({
  id: row.id,
  channelId: row.channelId,
  conversationId: row.conversationId,
  turnId: row.turnId,
  requestId: row.requestId,
  request: EngineRequest.parse(JSON.parse(row.request)),
  hire: AskHireProposal.optional().parse(
    row.hire ? JSON.parse(row.hire) : undefined,
  ),
  ...(row.why ? { why: row.why } : {}),
  ...(row.ifYes ? { ifYes: row.ifYes } : {}),
  ...(row.ifNo ? { ifNo: row.ifNo } : {}),
  state: row.state,
  outcome: ApprovalOutcome.optional().parse(row.outcome ?? undefined),
  answer: row.answer ?? undefined,
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt ?? undefined,
});

type PairedDeviceRow = typeof schema.pairedDevices.$inferSelect;
/** Rows keep the credential hash; the public device record never carries it. */
const rowToDevice = (row: PairedDeviceRow): PairedDevice => ({
  id: row.id,
  name: row.name,
  pairedAt: row.pairedAt,
  lastSeenAt: row.lastSeenAt,
});

type ProfileRow = typeof schema.profile.$inferSelect;
type GoalRow = typeof schema.goals.$inferSelect;
/* NULL owner means the human (D-#776). The contract field is optional. */
const rowToGoal = (row: GoalRow): Goal => {
  const { ownerId, ...rest } = row;
  return ownerId ? { ...rest, ownerId } : rest;
};

type TicketRow = typeof schema.tickets.$inferSelect;
const rowToTicket = (row: TicketRow): Ticket => {
  const waiting = row.waitingOn
    ? TicketWaitingOn.parse(JSON.parse(row.waitingOn))
    : undefined;
  const result = row.result
    ? TicketResult.parse(JSON.parse(row.result))
    : undefined;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    projectId: row.projectId,
    ...(row.goalId ? { goalId: row.goalId } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    status: TicketStatus.parse(row.status),
    ...(waiting ? { waitingOn: waiting } : {}),
    progress: TicketStep.array().parse(JSON.parse(row.progress)),
    ...(result ? { result } : {}),
    updates: parseUpdates(row.updates),
    ...(row.stuckWhy ? { stuckWhy: row.stuckWhy } : {}),
    ...(row.startsAt ? { startsAt: row.startsAt } : {}),
    statusAt: row.statusAt,
    ...(row.doneAt != null ? { doneAt: row.doneAt } : {}),
    /* D-#844: JSON `TicketTask` — the hand-off lineage + wake fence. */
    ...(row.task ? { task: TicketTask.parse(JSON.parse(row.task)) } : {}),
    createdAt: row.createdAt,
  };
};
const ticketToRow = (t: Ticket): typeof schema.tickets.$inferInsert => ({
  id: t.id,
  projectId: t.projectId,
  number: t.number,
  title: t.title,
  goalId: t.goalId ?? null,
  ownerId: t.ownerId ?? null,
  status: t.status,
  waitingOn: t.waitingOn ? JSON.stringify(t.waitingOn) : null,
  progress: JSON.stringify(t.progress),
  result: t.result ? JSON.stringify(t.result) : null,
  updates: JSON.stringify(t.updates),
  stuckWhy: t.stuckWhy ?? null,
  startsAt: t.startsAt ?? null,
  statusAt: t.statusAt,
  doneAt: t.doneAt ?? null,
  task: t.task ? JSON.stringify(t.task) : null,
  taskParentId: t.task?.parentConversationId ?? null,
  taskRequestId: t.task?.requestId ?? null,
  createdAt: t.createdAt,
});

const rowToProfile = (row: ProfileRow): ProfileSettings => ({
  userName: row.userName ?? undefined,
  companyName: row.companyName ?? undefined,
  avatarColor: row.avatarColor ?? undefined,
});

export function createDrizzleStore(db: Db): RelayStore {
  const now = () => Date.now();

  function rowToUpdate(row: {
    id: string;
    kind: string;
    text: string;
    ticketId: string | null;
    goalId: string | null;
    authorKind: string;
    authorId: string | null;
    createdAt: number;
  }): CompanyUpdate {
    return {
      id: row.id,
      kind: row.kind as CompanyUpdate["kind"],
      text: row.text,
      ...(row.ticketId ? { ticketId: row.ticketId } : {}),
      ...(row.goalId ? { goalId: row.goalId } : {}),
      authorKind: row.authorKind as CompanyUpdate["authorKind"],
      ...(row.authorId ? { authorId: row.authorId } : {}),
      createdAt: row.createdAt,
    };
  }

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
      rewound: false,
      dropped: false,
      removed: false,
      claimed: false,
      text: input.text,
      ...(input.ceoWake ? { ceoWake: true as const } : {}),
      ...(input.taskWake ? { taskWake: true as const } : {}),
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
    /* D-#777: storing a wake marks the conversation as the standing
       thread, including one opened before this flag existed. */
    if (input.ceoWake && input.conversationId) {
      db.update(schema.conversations)
        .set({ ceoThread: true })
        .where(eq(schema.conversations.id, input.conversationId))
        .run();
    }
    const { dedupeKey: _dedupeKey, ...appMessage } = message;
    return { message: appMessage, created: true };
  };

  /* #196: retired "No folder:" notes stay in the table but never read out
     (their dedupe key marks them; NULL = a normal message). */
  const messageVisible = () =>
    or(
      isNull(schema.messages.dedupeKey),
      notLike(schema.messages.dedupeKey, NO_FOLDER_DEDUPE_LIKE),
    );

  const conversationMessages = (conversationId: string) =>
    db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          messageVisible(),
        ),
      )
      .orderBy(asc(schema.messages.seq))
      .all();

  const openConversationTx = (
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    input: OpenConversationInput,
  ) => {
    /* #552: the open's key rides the root message's (channelId,
           dedupeKey) index — the same slot appendMessage dedupes on — so
           a stored-but-unanswered resend returns the stored thread. */
    if (input.dedupeKey) {
      const stored = tx
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.channelId, input.channelId),
            eq(schema.messages.dedupeKey, input.dedupeKey),
          ),
        )
        .get();
      const conversation = stored?.conversationId
        ? tx
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, stored.conversationId))
            .get()
        : undefined;
      if (stored && conversation) {
        return {
          conversation: rowToConversation(conversation),
          rootMessage: rowToMessage(stored),
          created: false,
        };
      }
    }
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
      authorKind: input.authorKind ?? "user",
      rewound: false,
      dropped: false,
      removed: false,
      claimed: false,
      text: input.text,
      ...(input.ceoWake ? { ceoWake: true as const } : {}),
      seq: bumped.seq,
      createdAt: now(),
      attachments: input.attachments,
    };
    // conversations.rootMessageId ↔ messages.conversationId are mutually
    // dependent FKs: insert the message unattributed, then the
    // conversation, then point the message at it — one transaction.
    tx.insert(schema.messages)
      .values({
        ...messageToRow(rootMessage),
        conversationId: null,
        dedupeKey: input.dedupeKey ?? null,
      })
      .run();
    const conversation: Conversation = {
      id: conversationId,
      channelId: input.channelId,
      rootMessageId: rootMessage.id,
      engineRef: null,
      state: "idle",
      ...openTitle(input),
      access: input.access ?? "ask",
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.ceoWake ? { ceoThread: true as const } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      archived: false,
      deliveredSeq: 0,
      readSeq: 0,
      finishedSeq: 0,
      createdAt: now(),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.fast !== undefined ? { fast: input.fast } : {}),
      ...(input.scheduled !== undefined ? { scheduled: input.scheduled } : {}),
    };
    tx.insert(schema.conversations)
      .values({
        ...conversation,
        /* D-#772: a new thread isn't stuck. The domain field is the
               parsed mark; the column is its JSON, so the spread can't
               carry the object through. */
        stuck: null,
        scheduled: conversation.scheduled
          ? JSON.stringify(conversation.scheduled)
          : null,
        workspace: conversation.workspace
          ? JSON.stringify(conversation.workspace)
          : null,
        usage: conversation.usage ? JSON.stringify(conversation.usage) : null,
        /* #419: the domain object holds TurnFailure; the column its
               JSON — absent rows stay NULL. */
        turnFailure: conversation.turnFailure
          ? JSON.stringify(conversation.turnFailure)
          : null,
        /* D-#862: same JSON boundary for `settledPr` — a fresh thread is
           never parked, so this only keeps the spread type honest. */
        settledPr: conversation.settledPr
          ? JSON.stringify(conversation.settledPr)
          : null,
        /* The domain flag is literal true. The column is 0/1. */
        ceoThread: conversation.ceoThread === true,
      })
      .run();
    /* The picker's folder bumps recents — a `.lilos/wt/*` run dir never
           makes the list (#156). */
    const bump = input.workspace?.repoPath ?? input.cwd;
    if (bump !== undefined) {
      const stamp = nextFolderStamp(tx);
      tx.insert(schema.recentFolders)
        .values({ path: bump, lastUsedAt: stamp })
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
    return { conversation, rootMessage, created: true };
  };

  return {
    async listEmployees() {
      return db
        .select()
        .from(schema.employees)
        .orderBy(asc(schema.employees.createdAt))
        .all()
        .map(rowToEmployee);
    },
    async getEmployee(id) {
      const row = db
        .select()
        .from(schema.employees)
        .where(eq(schema.employees.id, id))
        .get();
      return row ? rowToEmployee(row) : null;
    },
    async createEmployee(input) {
      /* A holder already in the seat: the new person reports to them,
         matching the Hire page (D-#778). No holder, they report to the
         owner (D-#775). A stale ceoId that names nobody is ignored. */
      let reportsTo: string | undefined;
      const stored = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, CEO_SETTING_KEY))
        .get();
      if (stored) {
        try {
          const value = JSON.parse(stored.value) as unknown;
          if (
            typeof value === "string" &&
            db
              .select({ id: schema.employees.id })
              .from(schema.employees)
              .where(eq(schema.employees.id, value))
              .get()
          ) {
            reportsTo = value;
          }
        } catch {
          reportsTo = undefined;
        }
      }
      const employee: Employee = {
        id: newId("emp"),
        createdAt: now(),
        ...input,
        ...(reportsTo ? { reportsTo } : {}),
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
      return updated ? rowToEmployee(updated) : null;
    },
    async removeEmployee(id) {
      return db.transaction((tx) => {
        const employee = tx
          .select()
          .from(schema.employees)
          .where(eq(schema.employees.id, id))
          .get();
        if (!employee) return null;
        /* Dependents point back at this row. Clear them first (they report
           to the owner again) — foreign keys are on, so the delete would
           fail while anyone still names this id (D-#775). */
        tx.update(schema.employees)
          .set({ reportsTo: null })
          .where(eq(schema.employees.reportsTo, id))
          .run();
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
          /* An employee's tasks die with it — the threads they opened
             keep the `scheduled` marker like any other leftover row. */
          tx.delete(schema.scheduledTasks)
            .where(eq(schema.scheduledTasks.employeeId, id))
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
        /* The holder leaving clears the position in this same write
           (D-#778). A later settings.changed is the session's job. */
        let clearedCeo = false;
        const stored = tx
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.key, CEO_SETTING_KEY))
          .get();
        if (stored) {
          try {
            const value = JSON.parse(stored.value) as unknown;
            if (value === id) {
              tx.delete(schema.settings)
                .where(eq(schema.settings.key, CEO_SETTING_KEY))
                .run();
              clearedCeo = true;
            }
          } catch {
            clearedCeo = false;
          }
        }
        return { employee: rowToEmployee(employee), channelIds, clearedCeo };
      });
    },
    async setCeo(employeeId) {
      const target = db
        .select()
        .from(schema.employees)
        .where(eq(schema.employees.id, employeeId))
        .get();
      if (!target) return null;
      const stored = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, CEO_SETTING_KEY))
        .get();
      let oldCeoId: string | undefined;
      if (stored) {
        try {
          const value = JSON.parse(stored.value) as unknown;
          if (typeof value === "string") oldCeoId = value;
        } catch {
          oldCeoId = undefined;
        }
      }
      /* Already the holder: the edges are the ones the last write left. */
      if (oldCeoId === employeeId) {
        return { ceoId: employeeId, employees: [], changed: false };
      }
      const all = db.select().from(schema.employees).all().map(rowToEmployee);
      const patches = reportsToAfterCeo(all, oldCeoId, employeeId);
      /* Refuse before the transaction so a cycle never lands (D-#778). */
      assertReportsAcyclic(withReportsTo(all, patches));
      const employees = db.transaction((tx) => {
        const changed: Employee[] = [];
        for (const patch of patches) {
          const updated = tx
            .update(schema.employees)
            .set({ reportsTo: patch.reportsTo })
            .where(eq(schema.employees.id, patch.id))
            .returning()
            .get();
          if (updated) changed.push(rowToEmployee(updated));
        }
        const serialized = JSON.stringify(employeeId);
        tx.insert(schema.settings)
          .values({ key: CEO_SETTING_KEY, value: serialized })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: serialized },
          })
          .run();
        return changed;
      });
      return { ceoId: employeeId, employees, changed: true };
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
      conversationId,
    }: ListConversationsQuery) {
      const conditions = [];
      if (channelId)
        conditions.push(eq(schema.conversations.channelId, channelId));
      if (conversationId)
        conditions.push(eq(schema.conversations.id, conversationId));
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
      conversationId,
    }: ListConversationsQuery) {
      /* #571: this is the hot list read — at 1,658 conversations the
         drizzle select layer's per-row mapping was ~2/3 of the budget, so
         every pass below runs raw through $client with explicit snake→
         camel aliases (flags arrive 0/1 and are coerced) and the row→
         domain mappers stay shared. Four passes total, all indexed:
         conversations (channel/id/archive filter, createdAt order), one
         grouped aggregate over each conv's (conversation_id, seq) range
         yielding the boundary seqs + visible count, then two seeks for
         exactly those rows — no per-conversation query, no full-thread
         materialization.
         Filters mirror `messageVisible()` + the rewound/dropped/removed
         flags: the root is looked up by id (a dedupe-visible no-folder
         opener keeps its conv out of the list, as before), `last` falls
         back to the newest dedupe-visible row so a rewind-to-root keeps
         headline text, and `messageCount` counts only visible rows. */
      const sqlite = db.$client;
      const convCols = `id, channel_id AS channelId,
        root_message_id AS rootMessageId, engine_ref AS engineRef, state,
        model, provider, effort, fast, cwd, project_id AS projectId,
        ticket_id AS ticketId, ceo_thread AS ceoThread, workspace, access, title,
        title_source AS titleSource, archived, delivered_seq AS deliveredSeq,
        pinned_at AS pinnedAt, settled_at AS settledAt,
        settled_reason AS settledReason, settled_pr AS settledPr,
        snoozed_until AS snoozedUntil, auto_settle AS autoSettle,
        usage, usage_session_id AS usageSessionId, usage_seq AS usageSeq,
        life, turn_failure AS turnFailure,
        turn_stopped AS turnStopped, bg_jobs AS bgJobs, stuck,
        stuck_at AS stuckAt,
        read_seq AS readSeq, finished_seq AS finishedSeq,
        finished_session_id AS finishedSessionId,
        finished_event_seq AS finishedEventSeq,
        created_at AS createdAt`;
      const convWhere: string[] = [];
      const convParams: (string | number)[] = [];
      if (channelId) {
        convWhere.push("channel_id = ?");
        convParams.push(channelId);
      }
      if (conversationId) {
        convWhere.push("id = ?");
        convParams.push(conversationId);
      }
      if (!includeArchived) convWhere.push("archived = 0");
      const convs = (
        sqlite
          .query(
            `SELECT ${convCols} FROM conversations
             ${convWhere.length ? `WHERE ${convWhere.join(" AND ")}` : ""}
             ORDER BY created_at`,
          )
          .all(...convParams) as Record<string, unknown>[]
      ).map((r) =>
        rowToConversation({
          ...r,
          archived: !!r.archived,
          fast: r.fast === null ? null : !!r.fast,
          /* #583: raw SQL returns the 0/1 integer — coerce like `fast` so
             the boolean schema doesn't see a number. */
          turnStopped: r.turnStopped == null ? null : !!r.turnStopped,
          ceoThread: !!r.ceoThread,
          /* D-#862: NOT NULL DEFAULT 1 column, raw SQL yields 0/1. */
          autoSettle: !!r.autoSettle,
        } as ConversationRow),
      );
      if (convs.length === 0) return [];
      const msgCols = `id, channel_id AS channelId,
        conversation_id AS conversationId, author_id AS authorId,
        author_kind AS authorKind, ceo_wake AS ceoWake, text, attachments, model, provider,
        effort, fast, seq, dedupe_key AS dedupeKey, rewound, dropped,
        removed, claimed, checkpoint, created_at AS createdAt`;
      const msgRows = (
        tail: string,
        params: (string | number)[],
      ): MessageRow[] =>
        (
          sqlite
            .query(`SELECT ${msgCols} FROM messages ${tail}`)
            .all(...params) as Record<string, unknown>[]
        ).map(
          (r) =>
            ({
              ...r,
              fast: r.fast === null ? null : !!r.fast,
              rewound: !!r.rewound,
              dropped: !!r.dropped,
              removed: !!r.removed,
              claimed: !!r.claimed,
              ceoWake: !!r.ceoWake,
            }) as MessageRow,
        );
      const convIds = convs.map((c) => c.id);
      const marks = convIds.map(() => "?").join(",");
      const dedupeVisible = `(dedupe_key IS NULL OR dedupe_key NOT LIKE '${NO_FOLDER_DEDUPE_LIKE}')`;
      const visible = `(rewound = 0 AND dropped = 0 AND removed = 0 AND ${dedupeVisible})`;
      interface AggRow {
        convId: string;
        visibleCount: number;
        firstAnswerSeq: number | null;
        lastVisibleSeq: number | null;
        lastAnySeq: number | null;
      }
      const aggs = new Map(
        (
          sqlite
            .query(
              `SELECT conversation_id AS convId,
                      SUM(CASE WHEN ${visible} THEN 1 ELSE 0 END) AS visibleCount,
                      MIN(CASE WHEN ${visible} AND author_kind = 'employee' THEN seq END) AS firstAnswerSeq,
                      MAX(CASE WHEN ${visible} THEN seq END) AS lastVisibleSeq,
                      MAX(CASE WHEN ${dedupeVisible} THEN seq END) AS lastAnySeq
               FROM messages
               WHERE conversation_id IN (${marks})
               GROUP BY conversation_id`,
            )
            .all(...convIds) as AggRow[]
        ).map((a) => [a.convId, a]),
      );
      /* Row-value seeks for each conv's last row (and first answer when it
         isn't the same row) — stay inside (conversation_id, seq). The root
         lookup goes by id (the conv's stored pointer): no seq is known for
         it, and id is the primary key. */
      const pairs: [string, number][] = [];
      for (const c of convs) {
        const a = aggs.get(c.id);
        if (!a) continue;
        if (a.firstAnswerSeq !== null) pairs.push([c.id, a.firstAnswerSeq]);
        const lastSeq = a.lastVisibleSeq ?? a.lastAnySeq;
        if (lastSeq !== null) pairs.push([c.id, lastSeq]);
      }
      const pairMarks = pairs.map(() => "(?, ?)").join(", ");
      const boundaryRows = pairs.length
        ? msgRows(
            `WHERE (conversation_id, seq) IN (VALUES ${pairMarks})`,
            pairs.flat(),
          )
        : [];
      const byPair = new Map(
        boundaryRows.map((r) => [`${r.conversationId}|${r.seq}`, r]),
      );
      const rootIds = convs.map((c) => c.rootMessageId);
      const rootsById = new Map(
        msgRows(`WHERE id IN (${marks})`, rootIds).map((r) => [r.id, r]),
      );
      const summaries: ConversationSummary[] = [];
      for (const conversation of convs) {
        const a = aggs.get(conversation.id);
        const rootRow = rootsById.get(conversation.rootMessageId);
        if (!a || !rootRow || noFolderDedupeKey(rootRow.dedupeKey)) continue;
        const lastSeq = a.lastVisibleSeq ?? a.lastAnySeq;
        const lastRow =
          lastSeq === null
            ? undefined
            : byPair.get(`${conversation.id}|${lastSeq}`);
        if (!lastRow) continue;
        const answerRow =
          a.firstAnswerSeq === null
            ? undefined
            : byPair.get(`${conversation.id}|${a.firstAnswerSeq}`);
        summaries.push({
          conversation,
          /* The desktop feed renders the root card's full text — only the
             answer/last previews take the cap. */
          root: toSummaryMessage(rowToMessage(rootRow)),
          firstAnswer: answerRow
            ? toSummaryPreview(rowToMessage(answerRow))
            : undefined,
          last: toSummaryPreview(rowToMessage(lastRow)),
          messageCount: Number(a.visibleCount),
        });
      }
      return summaries;
    },
    async listScheduledTasks(employeeId?: string): Promise<ScheduledTask[]> {
      const rows = employeeId
        ? db
            .select()
            .from(schema.scheduledTasks)
            .where(eq(schema.scheduledTasks.employeeId, employeeId))
            .all()
        : db.select().from(schema.scheduledTasks).all();
      return rows
        .map(rowToScheduledTask)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async getScheduledTask(id: string): Promise<ScheduledTask | null> {
      const row = db
        .select()
        .from(schema.scheduledTasks)
        .where(eq(schema.scheduledTasks.id, id))
        .get();
      return row ? rowToScheduledTask(row) : null;
    },
    async createScheduledTask(input: NewScheduledTask) {
      const task: ScheduledTask = {
        id: newId("task"),
        employeeId: input.employeeId,
        name: input.name,
        prompt: input.prompt,
        ...(input.folder !== undefined ? { folder: input.folder } : {}),
        schedule: input.schedule,
        access: input.access,
        createdAt: now(),
      };
      db.insert(schema.scheduledTasks)
        .values({
          id: task.id,
          employeeId: task.employeeId,
          name: task.name,
          prompt: task.prompt,
          folder: task.folder ?? null,
          schedule: JSON.stringify(task.schedule),
          access: task.access,
          createdAt: task.createdAt,
        })
        .run();
      return task;
    },
    async updateScheduledTask(id: string, patch: ScheduledTaskPatch) {
      const sets: Record<string, unknown> = {};
      if (patch.name !== undefined) sets.name = patch.name;
      if (patch.prompt !== undefined) sets.prompt = patch.prompt;
      if (patch.folder !== undefined) sets.folder = patch.folder;
      if (patch.schedule !== undefined)
        sets.schedule = JSON.stringify(patch.schedule);
      if (patch.access !== undefined) sets.access = patch.access;
      if (patch.paused !== undefined) sets.paused = patch.paused;
      if (patch.lastRun !== undefined)
        sets.lastRun = patch.lastRun ? JSON.stringify(patch.lastRun) : null;
      if (patch.skippedAt !== undefined) sets.skippedAt = patch.skippedAt;
      if (patch.lastFiredAt !== undefined) sets.lastFiredAt = patch.lastFiredAt;
      if (patch.requestedAt !== undefined) sets.requestedAt = patch.requestedAt;
      if (Object.keys(sets).length === 0) return this.getScheduledTask(id);
      const row = db
        .update(schema.scheduledTasks)
        .set(sets)
        .where(eq(schema.scheduledTasks.id, id))
        .returning()
        .get();
      return row ? rowToScheduledTask(row) : null;
    },
    async deleteScheduledTask(id: string) {
      const row = db
        .delete(schema.scheduledTasks)
        .where(eq(schema.scheduledTasks.id, id))
        .returning()
        .get();
      return row ? rowToScheduledTask(row) : null;
    },
    async listProjects(): Promise<Project[]> {
      return db
        .select()
        .from(schema.projects)
        .orderBy(asc(schema.projects.createdAt), sql`rowid`)
        .all();
    },
    async getProject(id: string): Promise<Project | null> {
      return (
        db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, id))
          .get() ?? null
      );
    },
    async ensureProject(input: NewProject) {
      /* One sync transaction = the atomic get-or-create: the unique
         indexes on folder and key back it, and nothing awaits between the
         read and the insert. */
      return db.transaction((tx) => {
        const existing = tx
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.folder, input.folder))
          .get();
        if (existing) return { project: existing, created: false };
        const taken = new Set(
          tx
            .select({ key: schema.projects.key })
            .from(schema.projects)
            .all()
            .map((r) => r.key),
        );
        const name = input.name ?? projectNameFor(input.folder);
        const project: Project = {
          id: newId("proj"),
          name,
          key: deriveProjectKey(name, taken),
          folder: input.folder,
          about: input.about ?? "",
          createdAt: input.createdAt ?? now(),
        };
        tx.insert(schema.projects).values(project).run();
        return { project, created: true };
      });
    },
    async listGoals(): Promise<Goal[]> {
      return db
        .select()
        .from(schema.goals)
        .orderBy(asc(schema.goals.createdAt), sql`rowid`)
        .all()
        .map(rowToGoal);
    },
    async createGoal(input: NewGoal): Promise<Goal> {
      const goal: Goal = {
        id: newId("goal"),
        title: input.title,
        projectId: input.projectId,
        due: input.due ?? "",
        why: input.why ?? "",
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        createdAt: now(),
      };
      db.insert(schema.goals)
        .values({ ...goal, ownerId: goal.ownerId ?? null })
        .run();
      return goal;
    },
    async listTickets(projectId?: string): Promise<Ticket[]> {
      const q = db
        .select()
        .from(schema.tickets)
        .orderBy(asc(schema.tickets.createdAt), sql`rowid`);
      const rows = projectId
        ? q.where(eq(schema.tickets.projectId, projectId)).all()
        : q.all();
      return rows.map(rowToTicket);
    },
    async getTicket(id: string): Promise<Ticket | null> {
      const row = db
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, id))
        .get();
      return row ? rowToTicket(row) : null;
    },
    async createTicket(input: NewTicket): Promise<Ticket> {
      return db.transaction((tx) => {
        const taken = tx
          .select({ n: schema.tickets.number })
          .from(schema.tickets)
          .where(eq(schema.tickets.projectId, input.projectId))
          .all();
        const number = taken.reduce((m, r) => Math.max(m, r.n), 0) + 1;
        const at = now();
        const settled = initialStatus(input);
        const ticket: Ticket = {
          id: `${input.projectKey}-${number}`,
          number,
          title: input.title,
          projectId: input.projectId,
          ...(input.goalId ? { goalId: input.goalId } : {}),
          ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          status: settled.status,
          ...(settled.waitingOn ? { waitingOn: settled.waitingOn } : {}),
          progress: input.progress ?? [],
          updates: [],
          ...(input.stuckWhy ? { stuckWhy: input.stuckWhy } : {}),
          ...(input.startsAt ? { startsAt: input.startsAt } : {}),
          statusAt: at,
          ...(settled.status === "done" ? { doneAt: at } : {}),
          createdAt: at,
        };
        tx.insert(schema.tickets).values(ticketToRow(ticket)).run();
        return ticket;
      });
    },
    async updateTicket(
      id: string,
      patch: TicketPatch,
    ): Promise<Ticket[] | null> {
      return db.transaction((tx) => {
        const row = tx
          .select()
          .from(schema.tickets)
          .where(eq(schema.tickets.id, id))
          .get();
        if (!row) return null;
        const before = rowToTicket(row);
        const at = now();
        let next = applyWrite(before, patch, at);
        const changed: Ticket[] = [];
        if (next.status === "done" && before.status !== "done") {
          next = finish(next, at);
          for (const other of tx.select().from(schema.tickets).all()) {
            const waiter = rowToTicket(other);
            if (
              waiter.waitingOn?.kind === "ticket" &&
              waiter.waitingOn.ticketId === id
            ) {
              const moved = wakeWaiter(waiter, next, at, newId("upd"));
              tx.update(schema.tickets)
                .set(ticketToRow(moved))
                .where(eq(schema.tickets.id, moved.id))
                .run();
              changed.push(moved);
            }
          }
        }
        tx.update(schema.tickets)
          .set(ticketToRow(next))
          .where(eq(schema.tickets.id, id))
          .run();
        return [next, ...changed];
      });
    },
    async assignTicket(input: {
      id: string;
      ownerId: string;
      channelId: string;
      access?: OpenConversationInput["access"];
    }) {
      /* Channel already exists. Owner + thread are one transaction (D-#776). */
      return db.transaction((tx) => {
        const row = tx
          .select()
          .from(schema.tickets)
          .where(eq(schema.tickets.id, input.id))
          .get();
        if (!row) return null;
        const project = tx
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, row.projectId))
          .get();
        if (!project) return null;
        const at = now();
        const ticket = checkout(rowToTicket(row), input.ownerId, at);
        tx.update(schema.tickets)
          .set(ticketToRow(ticket))
          .where(eq(schema.tickets.id, ticket.id))
          .run();
        const opened = openConversationTx(tx, {
          channelId: input.channelId,
          title: ticket.title,
          titleSource: "user",
          text: `${ticket.id}: ${ticket.title}`,
          authorId: "user",
          cwd: project.folder,
          projectId: project.id,
          ticketId: ticket.id,
          ...(input.access !== undefined ? { access: input.access } : {}),
        });
        return {
          ticket,
          conversation: opened.conversation,
          rootMessage: opened.rootMessage,
        };
      });
    },
    async commentTicket(id: string, update: { by: string; text: string }) {
      const row = db
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, id))
        .get();
      if (!row) return null;
      const ticket = withUpdate(
        rowToTicket(row),
        commentUpdate(newId("upd"), update.by, update.text, now()),
      );
      db.update(schema.tickets)
        .set(ticketToRow(ticket))
        .where(eq(schema.tickets.id, id))
        .run();
      return ticket;
    },
    async listUpdates() {
      const rows = db
        .select()
        .from(schema.companyUpdates)
        .orderBy(desc(schema.companyUpdates.createdAt), desc(sql`rowid`))
        .all();
      return rows.map(rowToUpdate);
    },
    async postUpdate(input) {
      const row = {
        id: newId("upd"),
        kind: input.kind,
        text: input.text,
        ticketId: input.ticketId ?? null,
        goalId: input.goalId ?? null,
        authorKind: input.authorKind,
        authorId: input.authorId ?? null,
        createdAt: now(),
      };
      db.insert(schema.companyUpdates).values(row).run();
      return rowToUpdate(row);
    },
    async threadsOnTicket(ticketId: string) {
      const rows = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.ticketId, ticketId))
        .orderBy(desc(schema.conversations.createdAt), desc(sql`rowid`))
        .all();
      return rows.map(rowToConversation);
    },
    /* D-#844: ticket + child thread in one transaction, like assignTicket —
       the (parent, requestId) index makes a retried create a hit. */
    async createTask(input: NewTask) {
      return db.transaction((tx) => {
        if (input.requestId) {
          const stored = tx
            .select()
            .from(schema.tickets)
            .where(
              and(
                eq(schema.tickets.taskParentId, input.parentConversationId),
                eq(schema.tickets.taskRequestId, input.requestId),
              ),
            )
            .get();
          if (stored?.task) {
            const task = TicketTask.parse(JSON.parse(stored.task));
            const conversation = tx
              .select()
              .from(schema.conversations)
              .where(eq(schema.conversations.id, task.childConversationId))
              .get();
            const rootMessage = conversation
              ? tx
                  .select()
                  .from(schema.messages)
                  .where(eq(schema.messages.id, conversation.rootMessageId))
                  .get()
              : undefined;
            if (conversation && rootMessage) {
              return {
                ticket: rowToTicket(stored),
                conversation: rowToConversation(conversation),
                rootMessage: rowToMessage(rootMessage),
                created: false,
              };
            }
          }
        }
        const taken = tx
          .select({ n: schema.tickets.number })
          .from(schema.tickets)
          .where(eq(schema.tickets.projectId, input.projectId))
          .all();
        const number = taken.reduce((m, r) => Math.max(m, r.n), 0) + 1;
        const at = now();
        const opened = openConversationTx(tx, {
          channelId: input.channelId,
          title: input.title,
          titleSource: "user",
          text: input.prompt,
          authorId: "user",
          access: input.access,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.workspace !== undefined
            ? { workspace: input.workspace }
            : {}),
          projectId: input.projectId,
          parentId: input.parentConversationId,
          /* ticketId lands once the row's number is known — the update
             below writes it in the same transaction. */
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
          ...(input.fast !== undefined ? { fast: input.fast } : {}),
        });
        const ticket: Ticket = {
          id: `${input.projectKey}-${number}`,
          number,
          title: input.title,
          projectId: input.projectId,
          ownerId: input.employeeId,
          status: "working",
          progress: [],
          updates: [],
          statusAt: at,
          task: {
            parentConversationId: input.parentConversationId,
            childConversationId: opened.conversation.id,
            childChannelId: input.channelId,
            ...(input.worktree ? { worktree: input.worktree } : {}),
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          createdAt: at,
        };
        tx.insert(schema.tickets).values(ticketToRow(ticket)).run();
        tx.update(schema.conversations)
          .set({ ticketId: ticket.id })
          .where(eq(schema.conversations.id, opened.conversation.id))
          .run();
        return {
          ticket,
          conversation: { ...opened.conversation, ticketId: ticket.id },
          rootMessage: opened.rootMessage,
          created: true,
        };
      });
    },
    async findTaskTicket(parentConversationId: string, requestId: string) {
      const row = db
        .select()
        .from(schema.tickets)
        .where(
          and(
            eq(schema.tickets.taskParentId, parentConversationId),
            eq(schema.tickets.taskRequestId, requestId),
          ),
        )
        .get();
      return row ? rowToTicket(row) : null;
    },
    async childConversations(parentId: string) {
      const rows = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.parentId, parentId))
        .orderBy(asc(schema.conversations.createdAt), asc(sql`rowid`))
        .all();
      return rows.map(rowToConversation);
    },
    /* D-#844: drop fenced events, group by parent, post + stamp in one
       transaction — the wake can never be posted without the fence or
       fenced without the post. Two batch events can name one finish (a
       replayed turn id and the catch-up scan's seq key): the LAST
       surviving event per task is the line, and every batch turn id of
       that task joins the fence so neither re-fires later. */
    async postTaskWake(events, text) {
      return db.transaction((tx) => {
        const latest = new Map<
          string,
          { event: TaskWakeEvent; task: TicketTask; ticket: Ticket }
        >();
        const turnIdsByTask = new Map<string, string[]>();
        for (const event of events) {
          const ids = turnIdsByTask.get(event.taskId) ?? [];
          ids.push(event.turnId);
          turnIdsByTask.set(event.taskId, ids);
          const row = tx
            .select()
            .from(schema.tickets)
            .where(eq(schema.tickets.id, event.taskId))
            .get();
          if (!row) continue;
          const ticket = rowToTicket(row);
          const task = ticket.task;
          /* A cancelled task never wakes (D-#844); a replayed turn id and
             a finish the stored result already covers drop silently. */
          if (!task || task.cancelledAt) continue;
          if (task.wakedTurnIds?.includes(event.turnId)) continue;
          const child = tx
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, task.childConversationId))
            .get();
          if (
            task.lastResult &&
            child &&
            task.lastResult.finishedSeq >= child.finishedSeq
          )
            continue;
          latest.set(event.taskId, { event, task, ticket });
        }
        const groups = new Map<
          string,
          { event: TaskWakeEvent; task: TicketTask; ticket: Ticket }[]
        >();
        for (const entry of latest.values()) {
          const group = groups.get(entry.task.parentConversationId) ?? [];
          group.push(entry);
          groups.set(entry.task.parentConversationId, group);
        }
        const delivered: string[] = [];
        const stamped: Ticket[] = [];
        const messages: AppMessage[] = [];
        for (const [parentId, group] of groups) {
          const parent = tx
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, parentId))
            .get();
          /* A parent thread that no longer exists can never be woken —
             still stamp the fence so the events stop retrying. */
          if (parent) {
            const appended = appendMessageTx({
              channelId: parent.channelId,
              conversationId: parent.id,
              authorId: "system",
              authorKind: "system",
              text: text(group.map((g) => g.event)),
              taskWake: true,
            });
            messages.push(appended.message);
          }
          for (const { event, task, ticket } of group) {
            const child = tx
              .select()
              .from(schema.conversations)
              .where(eq(schema.conversations.id, task.childConversationId))
              .get();
            const nextTask: TicketTask = {
              ...task,
              wakedTurnIds: [
                ...(task.wakedTurnIds ?? []),
                ...(turnIdsByTask.get(ticket.id) ?? []),
              ],
              lastResult: {
                turnId: event.turnId,
                outcome: event.outcome,
                text: event.result ?? "",
                finishedSeq: child?.finishedSeq ?? 0,
                at: now(),
              },
            };
            const status = event.outcome === "finished" ? "done" : "failed";
            let next = applyWrite(ticket, { task: nextTask }, now());
            next = applyWrite(next, { status }, now());
            if (next.status === "done" && ticket.status !== "done") {
              next = finish(next, now());
              for (const other of tx.select().from(schema.tickets).all()) {
                const waiter = rowToTicket(other);
                if (
                  waiter.waitingOn?.kind === "ticket" &&
                  waiter.waitingOn.ticketId === ticket.id
                ) {
                  const moved = wakeWaiter(waiter, next, now(), newId("upd"));
                  tx.update(schema.tickets)
                    .set(ticketToRow(moved))
                    .where(eq(schema.tickets.id, moved.id))
                    .run();
                  stamped.push(moved);
                }
              }
            }
            tx.update(schema.tickets)
              .set(ticketToRow(next))
              .where(eq(schema.tickets.id, ticket.id))
              .run();
            stamped.push(next);
            delivered.push(ticket.id);
          }
        }
        return { delivered, messages, tickets: stamped };
      });
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
      return db.transaction((tx) => openConversationTx(tx, input));
    },
    async setConversationProjects(filings) {
      db.transaction((tx) => {
        for (const { conversationId, projectId } of filings) {
          tx.update(schema.conversations)
            .set({ projectId })
            .where(eq(schema.conversations.id, conversationId))
            .run();
        }
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
      /* turnFailure crosses the patch API as the domain object (#419);
         the column holds its JSON like `workspace`/`usage` — serialize at
         the boundary, `null` clears. */
      const { turnFailure, stuck, settledPr, ...cols } = patch;
      /* D-#862: park writes. `archived` is the legacy settle alias —
         translate it to a manual settle so old callers keep working; an
         explicit settleAt write wins over a stray archived flag, and the
         mirror column always follows settledAt. Settling drops the pin and
         any snooze — a settled thread needs neither. */
      let parkSync: Partial<typeof schema.conversations.$inferInsert> = {};
      if (patch.settledAt !== undefined) {
        /* A settled thread is never pinned or snoozed — the shelf row
           carries no badge; un-settling clears the reason. */
        parkSync =
          patch.settledAt != null
            ? { archived: true, pinnedAt: null, snoozedUntil: null }
            : { archived: false, settledReason: null, settledPr: null };
      } else if (patch.archived !== undefined) {
        parkSync = patch.archived
          ? {
              settledAt: now(),
              settledReason: "manual" as const,
              settledPr: null,
              pinnedAt: null,
              snoozedUntil: null,
            }
          : { settledAt: null, settledReason: null, settledPr: null };
      }
      /* Issue #775: stamp stuckAt only when stuck goes unset → set. A
         clear leaves the stamp; a rewrite while it is still set is not a
         new episode; the next unset → set overwrites it. The host patch
         cannot carry the stamp. */
      let stuckAtStamp: number | undefined;
      if (stuck != null) {
        const current = db
          .select({ stuck: schema.conversations.stuck })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id))
          .get();
        if (!current) return null;
        if (!current.stuck) stuckAtStamp = now();
      }
      const updated = db
        .update(schema.conversations)
        .set({
          ...cols,
          ...parkSync,
          /* D-#862: same boundary as turnFailure — the column holds JSON,
             `null` clears. */
          ...(settledPr !== undefined
            ? {
                settledPr:
                  settledPr === null ? null : JSON.stringify(settledPr),
              }
            : {}),
          ...(turnFailure !== undefined
            ? {
                turnFailure:
                  turnFailure === null ? null : JSON.stringify(turnFailure),
              }
            : {}),
          /* D-#772: same boundary as turnFailure — the column holds JSON,
             `null` clears. The stamp beside it is not cleared. */
          ...(stuck !== undefined
            ? { stuck: stuck === null ? null : JSON.stringify(stuck) }
            : {}),
          ...(stuckAtStamp !== undefined ? { stuckAt: stuckAtStamp } : {}),
        })
        .where(eq(schema.conversations.id, id))
        .returning()
        .get();
      return updated ? rowToConversation(updated) : null;
    },
    async recordConversationFinish({ conversationId, sessionId, eventSeq }) {
      /* D-#563: the stamp must clear every mark the relay has seen —
         max(channel.lastSeq, readSeq) + 1 — because the finish's own
         channel writes land AFTER the engine event that calls this: at
         `lastSeq` a quiet-channel finish would equal `readSeq` and the
         dot would silently miss. The conditional UPDATE keeps the
         freshness fence atomic, same rule as `recordTurnUsage`: a
         replayed finish from the same session only wins past the stored
         event seq; a rebound session always writes. */
      const row = db
        .select({
          lastSeq: schema.channels.lastSeq,
          readSeq: schema.conversations.readSeq,
          ceoThread: schema.conversations.ceoThread,
        })
        .from(schema.conversations)
        .innerJoin(
          schema.channels,
          eq(schema.conversations.channelId, schema.channels.id),
        )
        .where(eq(schema.conversations.id, conversationId))
        .get();
      if (!row) return;
      /* D-#777: the standing thread's turns are updates, not unseen. */
      if (row.ceoThread) return;
      const stamp = Math.max(row.lastSeq, row.readSeq) + 1;
      db.update(schema.conversations)
        .set({
          finishedSeq: stamp,
          finishedSessionId: sessionId,
          finishedEventSeq: eventSeq,
        })
        .where(
          and(
            eq(schema.conversations.id, conversationId),
            lt(schema.conversations.finishedSeq, stamp),
            or(
              isNull(schema.conversations.finishedSessionId),
              ne(schema.conversations.finishedSessionId, sessionId),
              lt(schema.conversations.finishedEventSeq, eventSeq),
            ),
          ),
        )
        .run();
    },
    async markConversationRead(conversationId) {
      /* The user's read watermark (#563): past every finish stamped so
         far — max(channel.lastSeq, finishedSeq), since a quiet-channel
         finish can sit ahead of lastSeq. */
      const row = db
        .select({
          channelId: schema.conversations.channelId,
          lastSeq: schema.channels.lastSeq,
          finishedSeq: schema.conversations.finishedSeq,
        })
        .from(schema.conversations)
        .innerJoin(
          schema.channels,
          eq(schema.conversations.channelId, schema.channels.id),
        )
        .where(eq(schema.conversations.id, conversationId))
        .get();
      if (!row) return null;
      const updated = db
        .update(schema.conversations)
        .set({ readSeq: Math.max(row.lastSeq, row.finishedSeq) })
        .where(eq(schema.conversations.id, conversationId))
        .returning()
        .get();
      return updated ? rowToConversation(updated) : null;
    },
    async recordTurnUsage({ conversationId, sessionId, seq, usage }) {
      /* One conditional UPDATE = the freshness fence + the write: a replayed
         turn from the same session only wins past the stored seq; a rebound
         session always writes. */
      db.update(schema.conversations)
        .set({
          usage: JSON.stringify(usage),
          usageSessionId: sessionId,
          usageSeq: seq,
        })
        .where(
          and(
            eq(schema.conversations.id, conversationId),
            or(
              isNull(schema.conversations.usageSessionId),
              ne(schema.conversations.usageSessionId, sessionId),
              lt(schema.conversations.usageSeq, seq),
            ),
          ),
        )
        .run();
    },
    async listMessages(
      channelId: string,
      {
        conversationId,
        afterSeq,
        limit,
        includeRewound,
        includeDropped,
      }: ListMessagesQuery,
    ): Promise<ListMessagesPage> {
      const channel = db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
        .get();
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      /* Removed rows never read out; dropped ones only for the not-sent
         tray's `includeDropped` reads (#315). */
      const scope = and(
        conversationId
          ? and(
              eq(schema.messages.channelId, channelId),
              eq(schema.messages.conversationId, conversationId),
              messageVisible(),
            )
          : and(eq(schema.messages.channelId, channelId), messageVisible()),
        eq(schema.messages.removed, false),
        ...(includeDropped ? [] : [eq(schema.messages.dropped, false)]),
        ...(includeRewound ? [] : [eq(schema.messages.rewound, false)]),
      );
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
        authorKind: "employee" | "system" | "user";
        snippet: string;
        createdAt: number;
      }>(sql`
        SELECT m.id AS messageId,
               m.conversation_id AS conversationId,
               m.channel_id AS channelId,
               m.author_id AS authorId,
               m.author_kind AS authorKind,
               snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
               m.created_at AS createdAt
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ${match}
          AND m.rewound = 0
          AND m.dropped = 0
          AND m.removed = 0
          AND (m.dedupe_key IS NULL OR m.dedupe_key NOT LIKE ${NO_FOLDER_DEDUPE_LIKE})
          ${channelId ? sql`AND m.channel_id = ${channelId}` : sql``}
          ${includeArchived ? sql`` : sql`AND (c.id IS NULL OR c.archived = 0)`}
        ORDER BY bm25(messages_fts), m.created_at DESC
        LIMIT ${limit}
      `);
    },
    async appendMessage(input) {
      return db.transaction(() => appendMessageTx(input));
    },
    async getMessage(id) {
      const row = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .get();
      return row ? rowToMessage(row) : null;
    },
    async setMessageCheckpoint(messageId, checkpoint) {
      const updated = db
        .update(schema.messages)
        .set({ checkpoint })
        .where(eq(schema.messages.id, messageId))
        .returning()
        .get();
      return updated ? rowToMessage(updated) : null;
    },
    async setMessageFlags(messageId, flags) {
      const set: {
        dropped?: boolean;
        removed?: boolean;
        claimed?: boolean;
      } = {};
      if (flags.dropped !== undefined) set.dropped = flags.dropped;
      if (flags.removed !== undefined) set.removed = flags.removed;
      if (flags.claimed !== undefined) set.claimed = flags.claimed;
      if (Object.keys(set).length === 0) {
        const row = db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, messageId))
          .get();
        return row ? rowToMessage(row) : null;
      }
      const updated = db
        .update(schema.messages)
        .set(set)
        .where(eq(schema.messages.id, messageId))
        .returning()
        .get();
      return updated ? rowToMessage(updated) : null;
    },
    async markRewound(conversationId, fromSeq) {
      return db.transaction((tx) => {
        const rows = tx
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, conversationId),
              sql`${schema.messages.seq} >= ${fromSeq}`,
              eq(schema.messages.rewound, false),
            ),
          )
          .orderBy(asc(schema.messages.seq))
          .all();
        if (rows.length === 0) return [];
        tx.update(schema.messages)
          .set({ rewound: true })
          .where(
            inArray(
              schema.messages.id,
              rows.map((r) => r.id),
            ),
          )
          .run();
        return rows.map((r) => rowToMessage({ ...r, rewound: true }));
      });
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
        hire: input.hire ? JSON.stringify(input.hire) : null,
        why: input.why ?? null,
        ifYes: input.ifYes ?? null,
        ifNo: input.ifNo ?? null,
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
    /* D-#862: the user's resume clock — the newest user row's stamp, one
       aggregate read the sweep runs per PR-linked thread. */
    async lastUserMessageAt(conversationId) {
      const row = db
        .select({ at: max(schema.messages.createdAt) })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, conversationId),
            eq(schema.messages.authorKind, "user"),
          ),
        )
        .get();
      return row?.at ?? undefined;
    },
    async insertPairingGrant(grant: {
      codeHash: string;
      createdAt: number;
      expiresAt: number;
    }) {
      db.insert(schema.pairingGrants).values(grant).run();
    },
    async consumePairingGrant(codeHash: string, at: number) {
      /* Atomic spend: the UPDATE's WHERE is the single-use+TTL gate, so a
         replay that races the first spend loses. A miss is then classified
         for the exchange answer. */
      const spent = db
        .update(schema.pairingGrants)
        .set({ consumedAt: at })
        .where(
          and(
            eq(schema.pairingGrants.codeHash, codeHash),
            isNull(schema.pairingGrants.consumedAt),
            gt(schema.pairingGrants.expiresAt, at),
          ),
        )
        .returning({ codeHash: schema.pairingGrants.codeHash })
        .get();
      if (spent) return "ok";
      const row = db
        .select()
        .from(schema.pairingGrants)
        .where(eq(schema.pairingGrants.codeHash, codeHash))
        .get();
      if (!row) return "unknown";
      if (row.consumedAt !== null) return "used";
      return "expired";
    },
    async exchangePairingGrant({
      codeHash,
      device,
      at,
    }: {
      codeHash: string;
      device: NewPairedDevice;
      at: number;
    }) {
      /* One transaction: the device insert can't burn the grant — a failure
         rolls the consume back so the phone can retry the same code. */
      return db.transaction((tx) => {
        const spent = tx
          .update(schema.pairingGrants)
          .set({ consumedAt: at })
          .where(
            and(
              eq(schema.pairingGrants.codeHash, codeHash),
              isNull(schema.pairingGrants.consumedAt),
              gt(schema.pairingGrants.expiresAt, at),
            ),
          )
          .returning({ codeHash: schema.pairingGrants.codeHash })
          .get();
        if (!spent) {
          const row = tx
            .select()
            .from(schema.pairingGrants)
            .where(eq(schema.pairingGrants.codeHash, codeHash))
            .get();
          if (!row) return { error: "unknown" as const };
          return {
            error:
              row.consumedAt !== null
                ? ("used" as const)
                : ("expired" as const),
          };
        }
        const inserted = tx
          .insert(schema.pairedDevices)
          .values(device)
          .returning()
          .get();
        return { device: rowToDevice(inserted) };
      });
    },
    async prunePairingGrants(at: number) {
      db.delete(schema.pairingGrants)
        .where(
          or(
            lte(schema.pairingGrants.expiresAt, at),
            isNotNull(schema.pairingGrants.consumedAt),
          ),
        )
        .run();
    },
    async insertPairedDevice(device: NewPairedDevice) {
      const row = db
        .insert(schema.pairedDevices)
        .values(device)
        .returning()
        .get();
      return rowToDevice(row);
    },
    async authenticateDevice({
      deviceId,
      credentialHash,
      seenAt,
    }: {
      deviceId: string;
      credentialHash: string;
      seenAt: number;
    }) {
      /* #568: fetch by id, then compare the credential hash in-process
         with equalSecret — a `WHERE credential_hash = ?` clause hands the
         compare to SQLite's early-exit, which a remote caller can time. */
      const row = db
        .select()
        .from(schema.pairedDevices)
        .where(
          and(
            eq(schema.pairedDevices.id, deviceId),
            isNull(schema.pairedDevices.revokedAt),
          ),
        )
        .get();
      if (!row || !equalSecret(row.credentialHash, credentialHash)) {
        return null;
      }
      const updated = db
        .update(schema.pairedDevices)
        .set({ lastSeenAt: seenAt })
        .where(
          and(
            eq(schema.pairedDevices.id, deviceId),
            isNull(schema.pairedDevices.revokedAt),
          ),
        )
        .returning()
        .get();
      return updated ? rowToDevice(updated) : rowToDevice(row);
    },
    async listPairedDevices() {
      const rows = db
        .select()
        .from(schema.pairedDevices)
        .where(isNull(schema.pairedDevices.revokedAt))
        .orderBy(asc(schema.pairedDevices.pairedAt))
        .all();
      return rows.map(rowToDevice);
    },
    async revokePairedDevice(id: string, revokedAt: number) {
      const row = db
        .update(schema.pairedDevices)
        .set({ revokedAt })
        .where(
          and(
            eq(schema.pairedDevices.id, id),
            isNull(schema.pairedDevices.revokedAt),
          ),
        )
        .returning()
        .get();
      // #161: a revoked phone also loses its push registration.
      db.delete(schema.devicePush)
        .where(eq(schema.devicePush.deviceId, id))
        .run();
      return row ? rowToDevice(row) : null;
    },
    async setDevicePush(input: {
      deviceId: string;
      token: string;
      prefs: PushPrefs;
      at: number;
    }) {
      db.insert(schema.devicePush)
        .values({
          deviceId: input.deviceId,
          expoToken: input.token,
          prefs: JSON.stringify(input.prefs),
          updatedAt: input.at,
        })
        .onConflictDoUpdate({
          target: schema.devicePush.deviceId,
          set: {
            expoToken: input.token,
            prefs: JSON.stringify(input.prefs),
            updatedAt: input.at,
          },
        })
        .run();
    },
    async listDevicePush(): Promise<DevicePush[]> {
      const rows = db.select().from(schema.devicePush).all();
      return rows.map((row) => ({
        deviceId: row.deviceId,
        token: row.expoToken,
        prefs: JSON.parse(row.prefs) as PushPrefs,
        updatedAt: row.updatedAt,
      }));
    },
    async dropDevicePush(deviceId: string) {
      db.delete(schema.devicePush)
        .where(eq(schema.devicePush.deviceId, deviceId))
        .run();
    },
    async advanceEngineEventSeq(input: {
      sessionId: string;
      seq: number;
      at: number;
    }) {
      /* Freshness = strictly-advancing seq (#161): the insert wins only for
         a session's first event; afterwards only a seq above the stored
         watermark counts as new, so a replayed `engine.event` never
         re-notifies. Both statements are no-ops on conflict/older seq. */
      const inserted = db
        .insert(schema.engineEventMarks)
        .values({
          sessionId: input.sessionId,
          lastSeq: input.seq,
          updatedAt: input.at,
        })
        .onConflictDoNothing()
        .returning({ sessionId: schema.engineEventMarks.sessionId })
        .get();
      if (inserted) return true;
      const advanced = db
        .update(schema.engineEventMarks)
        .set({ lastSeq: input.seq, updatedAt: input.at })
        .where(
          and(
            eq(schema.engineEventMarks.sessionId, input.sessionId),
            lt(schema.engineEventMarks.lastSeq, input.seq),
          ),
        )
        .returning({ sessionId: schema.engineEventMarks.sessionId })
        .get();
      return advanced !== undefined;
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
            (m) =>
              /* D-#844: a task wake owes the parent a turn like a user
                 send or a CEO wake — restart pending covers it. */
              (m.authorKind === "user" ||
                m.ceoWake === true ||
                m.taskWake === true) &&
              !m.rewound &&
              !m.dropped &&
              !m.removed &&
              m.seq > conversation.deliveredSeq,
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
