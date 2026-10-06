import type {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
  MessageSearchHit,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  RecentFolder,
} from "@lilos/contracts/app";
import { equalSecret } from "@lilos/contracts/auth";
import type {
  AppendMessageInput,
  DevicePush,
  NewPairedDevice,
  RelayStore,
} from "../src/store";
import {
  markSnippet,
  messageMatchesTerms,
  newId,
  noFolderDedupeKey,
  openTitle,
  searchTerms,
  titlePatch,
} from "../src/store";

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
      claimed: false,
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
        ...(input.workspace !== undefined
          ? { workspace: input.workspace }
          : {}),
        ...openTitle(input),
        archived: false,
        deliveredSeq: 0,
        access: input.access ?? "ask",
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
        dedupeKey: input.dedupeKey,
      });
      conversation.rootMessageId = rootMessage.id;
      return { conversation, rootMessage, created: true };
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
      ] as const) {
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
