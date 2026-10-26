import type {
  AppChannel,
  AppMessage,
  Ask,
  CompanyUpdate,
  Conversation,
  ConversationSummary,
  Employee,
  Goal,
  MessageSearchHit,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  Project,
  RecentFolder,
  ScheduledTask,
  TaskWakeEvent,
  Ticket,
  TicketTask,
} from "@lilos/contracts/app";
import {
  assertReportsAcyclic,
  CEO_SETTING_KEY,
  reportsToAfterCeo,
  toSummaryMessage,
  toSummaryPreview,
  withReportsTo,
} from "@lilos/contracts/app";
import { equalSecret } from "@lilos/contracts/auth";
import type {
  AppendMessageInput,
  DevicePush,
  NewGoal,
  NewPairedDevice,
  NewProject,
  NewTicket,
  OpenConversationInput,
  RelayStore,
  TicketPatch,
} from "../src/store";
import {
  deriveProjectKey,
  markSnippet,
  messageMatchesTerms,
  newId,
  noFolderDedupeKey,
  openTitle,
  projectNameFor,
  searchTerms,
  titlePatch,
} from "../src/store";
import {
  applyWrite,
  checkout,
  commentUpdate,
  finish,
  initialStatus,
  wakeWaiter,
  withUpdate,
} from "../src/work";

export type { RelayStore };

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

/** Reference implementation used by unit tests; SQLite is the shipped one. */
export function createMemoryStore(): RelayStore {
  const employees = new Map<string, Employee>();
  const channels = new Map<string, AppChannel>();
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, AppMessage>();
  const asks = new Map<string, Ask>();
  const folders = new Map<string, RecentFolder>();
  const settings = new Map<string, unknown>();
  const scheduledTasks = new Map<string, ScheduledTask>();
  const projects = new Map<string, Project>();
  const goals = new Map<string, Goal>();
  const tickets = new Map<string, Ticket>();
  const companyUpdates: CompanyUpdate[] = [];
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
  const finishMarks = new Map<string, { sessionId: string; seq: number }>();

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
      claimed: false,
      text: input.text,
      ...(input.ceoWake ? { ceoWake: true as const } : {}),
      ...(input.taskWake ? { taskWake: true as const } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.fast !== undefined ? { fast: input.fast } : {}),
      seq,
      createdAt: now(),
      attachments: input.attachments,
    };
    messages.set(message.id, message);
    if (input.ceoWake && input.conversationId) {
      const conversation = conversations.get(input.conversationId);
      if (conversation) conversation.ceoThread = true;
    }
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

  const openConversationSync = (input: OpenConversationInput) => {
    /* #552: the open's key rides the root message's (channelId,
         dedupeKey) slot — a stored-but-unanswered resend answers the
         stored thread. */
    if (input.dedupeKey) {
      const storedId = dedupe.get(`${input.channelId}|${input.dedupeKey}`);
      const stored = storedId ? messages.get(storedId) : undefined;
      const conv = stored?.conversationId
        ? conversations.get(stored.conversationId)
        : undefined;
      if (stored && conv) {
        return { conversation: conv, rootMessage: stored, created: false };
      }
    }
    const conversation: Conversation = {
      id: newId("conv"),
      channelId: input.channelId,
      rootMessageId: "",
      engineRef: null,
      state: "idle",
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.ceoWake ? { ceoThread: true as const } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...openTitle(input),
      archived: false,
      deliveredSeq: 0,
      readSeq: 0,
      finishedSeq: 0,
      access: input.access ?? "ask",
      createdAt: now(),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.fast !== undefined ? { fast: input.fast } : {}),
      ...(input.scheduled !== undefined ? { scheduled: input.scheduled } : {}),
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
      authorKind: input.authorKind ?? "user",
      text: input.text,
      ...(input.ceoWake ? { ceoWake: true as const } : {}),
      attachments: input.attachments,
      dedupeKey: input.dedupeKey,
    });
    conversation.rootMessageId = rootMessage.id;
    return { conversation, rootMessage, created: true };
  };

  return {
    async listEmployees() {
      return [...employees.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async getEmployee(id) {
      return employees.get(id) ?? null;
    },
    async createEmployee(input) {
      const stored = settings.get(CEO_SETTING_KEY);
      const reportsTo =
        typeof stored === "string" && employees.has(stored)
          ? stored
          : undefined;
      const employee: Employee = {
        id: newId("emp"),
        createdAt: now(),
        ...input,
        ...(reportsTo ? { reportsTo } : {}),
      };
      employees.set(employee.id, employee);
      return employee;
    },
    async updateEmployee(id, patch) {
      const employee = employees.get(id);
      if (!employee) return null;
      const { reportsTo, ...rest } = patch;
      Object.assign(employee, rest);
      /* null clears the link (back to the owner). undefined leaves it. */
      if (reportsTo === null) delete employee.reportsTo;
      else if (typeof reportsTo === "string") employee.reportsTo = reportsTo;
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
      /* An employee's tasks die with it; the runs they opened keep
         their `scheduled` marker like any other leftover row. */
      for (const [tid, task] of scheduledTasks) {
        if (task.employeeId === id) scheduledTasks.delete(tid);
      }
      /* Whoever reported to this person reports to the owner again (D-#775). */
      for (const other of employees.values()) {
        if (other.reportsTo === id) delete other.reportsTo;
      }
      employees.delete(id);
      const clearedCeo = settings.get(CEO_SETTING_KEY) === id;
      if (clearedCeo) settings.delete(CEO_SETTING_KEY);
      return { employee, channelIds: [...channelIds], clearedCeo };
    },
    async setCeo(employeeId) {
      if (!employees.has(employeeId)) return null;
      const stored = settings.get(CEO_SETTING_KEY);
      const oldCeoId = typeof stored === "string" ? stored : undefined;
      if (oldCeoId === employeeId) {
        return { ceoId: employeeId, employees: [], changed: false };
      }
      const all = [...employees.values()].map((e) => ({
        id: e.id,
        reportsTo: e.reportsTo,
      }));
      const patches = reportsToAfterCeo(all, oldCeoId, employeeId);
      assertReportsAcyclic(withReportsTo(all, patches));
      const changed: Employee[] = [];
      for (const patch of patches) {
        const row = employees.get(patch.id);
        if (!row) continue;
        if (patch.reportsTo === null) delete row.reportsTo;
        else row.reportsTo = patch.reportsTo;
        changed.push(row);
      }
      settings.set(CEO_SETTING_KEY, employeeId);
      return { ceoId: employeeId, employees: changed, changed: true };
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
    async listConversations({ channelId, includeArchived, conversationId }) {
      return [...conversations.values()]
        .filter((c) => (channelId ? c.channelId === channelId : true))
        .filter((c) => (conversationId ? c.id === conversationId : true))
        .filter((c) => (includeArchived ? true : !c.archived))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async listScheduledTasks(employeeId) {
      return [...scheduledTasks.values()]
        .filter((t) => (employeeId ? t.employeeId === employeeId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async getScheduledTask(id) {
      return scheduledTasks.get(id) ?? null;
    },
    async createScheduledTask(input) {
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
      scheduledTasks.set(task.id, task);
      return task;
    },
    async updateScheduledTask(id, patch) {
      const task = scheduledTasks.get(id);
      if (!task) return null;
      for (const k of [
        "folder",
        "lastRun",
        "skippedAt",
        "lastFiredAt",
        "requestedAt",
      ] as const) {
        if (patch[k] === null) {
          delete (task as Record<string, unknown>)[k];
          patch = { ...patch, [k]: undefined };
        }
      }
      Object.assign(task, patch);
      return task;
    },
    async deleteScheduledTask(id) {
      const task = scheduledTasks.get(id);
      if (!task) return null;
      scheduledTasks.delete(id);
      return task;
    },
    async listProjects() {
      return [...projects.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async getProject(id) {
      return projects.get(id) ?? null;
    },
    async ensureProject(input: NewProject) {
      const existing = [...projects.values()].find(
        (p) => p.folder === input.folder,
      );
      if (existing) return { project: existing, created: false };
      const name = input.name ?? projectNameFor(input.folder);
      const project: Project = {
        id: newId("proj"),
        name,
        key: deriveProjectKey(
          name,
          new Set([...projects.values()].map((p) => p.key)),
        ),
        folder: input.folder,
        about: input.about ?? "",
        createdAt: input.createdAt ?? now(),
      };
      projects.set(project.id, project);
      return { project, created: true };
    },
    async listGoals() {
      return [...goals.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async createGoal(input: NewGoal) {
      const goal: Goal = {
        id: newId("goal"),
        title: input.title,
        projectId: input.projectId,
        due: input.due ?? "",
        why: input.why ?? "",
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        createdAt: now(),
      };
      goals.set(goal.id, goal);
      return goal;
    },
    async listTickets(projectId?: string) {
      return [...tickets.values()]
        .filter((t) => (projectId ? t.projectId === projectId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async getTicket(id: string) {
      return tickets.get(id) ?? null;
    },
    async createTicket(input: NewTicket) {
      const taken = [...tickets.values()].filter(
        (t) => t.projectId === input.projectId,
      );
      const number = taken.reduce((m, t) => Math.max(m, t.number), 0) + 1;
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
      tickets.set(ticket.id, ticket);
      return ticket;
    },
    async updateTicket(id: string, patch: TicketPatch) {
      const before = tickets.get(id);
      if (!before) return null;
      const at = now();
      let next = applyWrite(before, patch, at);
      const changed: Ticket[] = [];
      if (next.status === "done" && before.status !== "done") {
        next = finish(next, at);
        for (const waiter of tickets.values()) {
          if (
            waiter.waitingOn?.kind === "ticket" &&
            waiter.waitingOn.ticketId === id
          ) {
            const moved = wakeWaiter(waiter, next, at, newId("upd"));
            tickets.set(moved.id, moved);
            changed.push(moved);
          }
        }
      }
      tickets.set(next.id, next);
      return [next, ...changed];
    },
    async assignTicket(input: {
      id: string;
      ownerId: string;
      channelId: string;
      access?: OpenConversationInput["access"];
    }) {
      /* No await: the owner write and the new thread land together (D-#776).
         The owner's channel was opened before this call. */
      const before = tickets.get(input.id);
      const project = before ? projects.get(before.projectId) : undefined;
      if (!before || !project) return null;
      const ticket = checkout(before, input.ownerId, now());
      tickets.set(ticket.id, ticket);
      const opened = openConversationSync({
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
    },
    async commentTicket(id: string, update: { by: string; text: string }) {
      const before = tickets.get(id);
      if (!before) return null;
      const ticket = withUpdate(
        before,
        commentUpdate(newId("upd"), update.by, update.text, now()),
      );
      tickets.set(ticket.id, ticket);
      return ticket;
    },
    async listUpdates() {
      /* Same-millisecond rows stay newest-first: a later insert wins the
         tie (D-#777). Drizzle breaks it with rowid. */
      return companyUpdates
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.createdAt - a.row.createdAt || b.index - a.index)
        .map((x) => x.row);
    },
    async postUpdate(input) {
      const update: CompanyUpdate = {
        id: newId("upd"),
        kind: input.kind,
        text: input.text,
        ...(input.ticketId ? { ticketId: input.ticketId } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        authorKind: input.authorKind,
        ...(input.authorId ? { authorId: input.authorId } : {}),
        createdAt: now(),
      };
      companyUpdates.push(update);
      return update;
    },
    async threadsOnTicket(ticketId: string) {
      const rows = [...conversations.values()].filter(
        (c) => c.ticketId === ticketId,
      );
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.createdAt - a.row.createdAt || b.index - a.index)
        .map((x) => x.row);
    },
    /* D-#844: the memory store mirrors the SQLite transaction — one
       synchronous block, retried requestIds hit the stored ticket. */
    async createTask(input) {
      if (input.requestId) {
        const stored = [...tickets.values()].find(
          (t) =>
            t.task?.parentConversationId === input.parentConversationId &&
            t.task.requestId === input.requestId,
        );
        const conversation = stored
          ? conversations.get(stored.task!.childConversationId)
          : undefined;
        const rootMessage = conversation
          ? messages.get(conversation.rootMessageId)
          : undefined;
        if (stored && conversation && rootMessage) {
          return { ticket: stored, conversation, rootMessage, created: false };
        }
      }
      const taken = [...tickets.values()].filter(
        (t) => t.projectId === input.projectId,
      );
      const number = taken.reduce((m, t) => Math.max(m, t.number), 0) + 1;
      const at = now();
      const opened = openConversationSync({
        channelId: input.channelId,
        title: input.title,
        titleSource: "user",
        text: input.prompt,
        authorId: "user",
        access: input.access,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        projectId: input.projectId,
        parentId: input.parentConversationId,
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
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        createdAt: at,
      };
      tickets.set(ticket.id, ticket);
      opened.conversation.ticketId = ticket.id;
      return {
        ticket,
        conversation: opened.conversation,
        rootMessage: opened.rootMessage,
        created: true,
      };
    },
    async findTaskTicket(parentConversationId, requestId) {
      return (
        [...tickets.values()].find(
          (t) =>
            t.task?.parentConversationId === parentConversationId &&
            t.task.requestId === requestId,
        ) ?? null
      );
    },
    async childConversations(parentId) {
      return [...conversations.values()]
        .filter((c) => c.parentId === parentId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    /* D-#844: one synchronous pass — fenced events drop, surviving events
       post one wake per parent and stamp the tickets; see drizzle-store. */
    async postTaskWake(events, text) {
      const latest = new Map<
        string,
        { event: TaskWakeEvent; task: TicketTask; ticket: Ticket }
      >();
      const turnIdsByTask = new Map<string, string[]>();
      for (const event of events) {
        const ids = turnIdsByTask.get(event.taskId) ?? [];
        ids.push(event.turnId);
        turnIdsByTask.set(event.taskId, ids);
        const ticket = tickets.get(event.taskId);
        const task = ticket?.task;
        if (!ticket || !task || task.cancelledAt) continue;
        if (task.wakedTurnIds?.includes(event.turnId)) continue;
        const child = conversations.get(task.childConversationId);
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
      const posted: AppMessage[] = [];
      for (const [parentId, group] of groups) {
        const parent = conversations.get(parentId);
        if (parent) {
          const { message } = appendMessage({
            channelId: parent.channelId,
            conversationId: parent.id,
            authorId: "system",
            authorKind: "system",
            text: text(group.map((g) => g.event)),
            taskWake: true,
          });
          posted.push(message);
        }
        for (const { event, task, ticket } of group) {
          const child = conversations.get(task.childConversationId);
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
            for (const waiter of tickets.values()) {
              if (
                waiter.waitingOn?.kind === "ticket" &&
                waiter.waitingOn.ticketId === ticket.id
              ) {
                const moved = wakeWaiter(waiter, next, now(), newId("upd"));
                tickets.set(moved.id, moved);
                stamped.push(moved);
              }
            }
          }
          tickets.set(next.id, next);
          stamped.push(next);
          delivered.push(next.id);
        }
      }
      return { delivered, messages: posted, tickets: stamped };
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
    async listConversationSummaries({
      channelId,
      includeArchived,
      conversationId,
    }) {
      const convs = await this.listConversations({
        channelId,
        includeArchived,
        conversationId,
      });
      const summaries: ConversationSummary[] = [];
      for (const conversation of convs) {
        const all = conversationMessages(conversation.id);
        /* SQLite parity (#571): dropped/removed hide a row just like a
           rewind — the old filter only dropped `rewound`. */
        const convMessages = all.filter(
          (m) => !m.rewound && !m.dropped && !m.removed,
        );
        /* A rewind to the root message leaves zero visible messages — the
           list row still renders the (rewound) root for context. */
        const root =
          convMessages.find((m) => m.id === conversation.rootMessageId) ??
          all.find((m) => m.id === conversation.rootMessageId);
        const last = convMessages.at(-1) ?? all.at(-1);
        if (!root || !last) continue;
        const answer = convMessages.find((m) => m.authorKind === "employee");
        summaries.push({
          conversation,
          root: toSummaryMessage(root),
          firstAnswer: answer ? toSummaryPreview(answer) : undefined,
          last: toSummaryPreview(last),
          messageCount: convMessages.length,
        });
      }
      return summaries;
    },
    async openConversation(input) {
      return openConversationSync(input);
    },
    async setConversationProjects(filings) {
      for (const { conversationId, projectId } of filings) {
        const conversation = conversations.get(conversationId);
        if (conversation) conversation.projectId = projectId;
      }
    },
    async updateConversation(id, patch) {
      const conversation = conversations.get(id);
      if (!conversation) return null;
      patch = titlePatch(patch, conversation);
      /* Issue #775: stamp stuckAt only on unset → set. Captured before the
         null-clear below deletes the live mark and drops the patch key. */
      const hadStuck = conversation.stuck != null;
      const marking = patch.stuck != null;
      // The delivery watermark only moves forward — a slower write must not
      // re-owe a later message its prompt.
      if (patch.deliveredSeq !== undefined) {
        patch.deliveredSeq = Math.max(
          conversation.deliveredSeq,
          patch.deliveredSeq,
        );
      }
      /* `null` in a patch clears an engine-pinned field (#92, and #419's
         turnFailure); the domain object holds `undefined`, never `null`. */
      for (const k of [
        "model",
        "provider",
        "effort",
        "fast",
        "turnFailure",
        "turnStopped",
        "bgJobs",
        "cwd",
        "projectId",
        "stuck",
      ] as const) {
        if (patch[k] === null) {
          delete (conversation as Record<string, unknown>)[k];
          patch = { ...patch, [k]: undefined };
        }
      }
      Object.assign(conversation, patch);
      if (marking && !hadStuck) conversation.stuckAt = now();
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
    async recordConversationFinish({ conversationId, sessionId, eventSeq }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.ceoThread) return;
      const mark = finishMarks.get(conversationId);
      if (mark && mark.sessionId === sessionId && eventSeq <= mark.seq) return;
      /* Same stamp rule as the real store (#563): strictly past every mark
         seen — the finish's own channel writes land after its engine
         event, so `lastSeq` alone could equal `readSeq` and miss. */
      const stamp =
        Math.max(
          channels.get(conversation.channelId)?.lastSeq ?? 0,
          conversation.readSeq,
        ) + 1;
      if (stamp <= conversation.finishedSeq) return;
      finishMarks.set(conversationId, { sessionId, seq: eventSeq });
      conversation.finishedSeq = stamp;
    },
    async markConversationRead(conversationId) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      const channel = channels.get(conversation.channelId);
      if (!channel) return null;
      conversation.readSeq = Math.max(
        channel.lastSeq,
        conversation.finishedSeq,
      );
      return conversation;
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
      if (flags.claimed !== undefined) message.claimed = flags.claimed;
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
        ...(input.hire ? { hire: input.hire } : {}),
        ...(input.why ? { why: input.why } : {}),
        ...(input.ifYes ? { ifYes: input.ifYes } : {}),
        ...(input.ifNo ? { ifNo: input.ifNo } : {}),
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
      // #568: same constant-time compare as the drizzle store.
      if (!equalSecret(device.credentialHash, credentialHash)) return null;
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
