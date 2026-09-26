import { randomUUID } from "node:crypto";
import type {
  AppChannel,
  AppMessage,
  AuthorKind,
  Conversation,
  ConversationState,
  Employee,
  EmployeeStatus,
  RespondTo,
} from "@lilos/contracts/app";

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
}

export interface OpenConversationInput {
  channelId: string;
  title: string;
  text: string;
  authorId: string;
}

export interface AppendMessageInput {
  channelId: string;
  conversationId?: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
}

export interface ListMessagesQuery {
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

  listChannels(): Promise<AppChannel[]>;
  getChannel(id: string): Promise<AppChannel | null>;
  /** Get-or-create the DM channel with this employee. */
  openDmChannel(employeeId: string): Promise<AppChannel>;

  listConversations(query: ListConversationsQuery): Promise<Conversation[]>;
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
  /** Appends with the channel's next seq (atomic with the counter bump). */
  appendMessage(input: AppendMessageInput): Promise<AppMessage>;
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

  const now = () => Date.now();
  const channelMessages = (channelId: string) =>
    [...messages.values()]
      .filter((m) => m.channelId === channelId)
      .sort((a, b) => a.seq - b.seq);

  const appendMessage = (input: AppendMessageInput): AppMessage => {
    const channel = channels.get(input.channelId);
    if (!channel) throw new Error(`unknown channel ${input.channelId}`);
    if (input.conversationId) {
      const conversation = conversations.get(input.conversationId);
      if (!conversation || conversation.channelId !== input.channelId) {
        throw new Error(`unknown conversation ${input.conversationId}`);
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
      text: input.text,
      seq,
      createdAt: now(),
    };
    messages.set(message.id, message);
    return message;
  };

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
      if (existing) return existing;
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
      return channel;
    },
    async listConversations({ channelId, includeArchived }) {
      return [...conversations.values()]
        .filter((c) => (channelId ? c.channelId === channelId : true))
        .filter((c) => (includeArchived ? true : !c.archived))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async getConversation(id) {
      return conversations.get(id) ?? null;
    },
    async openConversation(input) {
      const conversation: Conversation = {
        id: newId("conv"),
        channelId: input.channelId,
        rootMessageId: "",
        engineRef: null,
        state: "idle",
        title: input.title,
        archived: false,
        createdAt: now(),
      };
      conversations.set(conversation.id, conversation);
      const rootMessage = appendMessage({
        channelId: input.channelId,
        conversationId: conversation.id,
        authorId: input.authorId,
        authorKind: "user",
        text: input.text,
      });
      conversation.rootMessageId = rootMessage.id;
      return { conversation, rootMessage };
    },
    async updateConversation(id, patch) {
      const conversation = conversations.get(id);
      if (!conversation) return null;
      Object.assign(conversation, patch);
      return conversation;
    },
    async listMessages(channelId, { afterSeq, limit }) {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`unknown channel ${channelId}`);
      let list = channelMessages(channelId);
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
  };
}
