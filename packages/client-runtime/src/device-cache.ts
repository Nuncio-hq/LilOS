import {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
  ProfileSettings,
} from "@lilos/contracts/app";
import { z } from "zod";

/**
 * On-device directory cache (#154): the phone renders Home from this before
 * the socket opens, then reconnects catch up via `afterSeq` replay on the
 * stored watermarks. Ported from T3 Code
 * `apps/mobile/src/connection/environment-cache-store.ts` (MIT) — a
 * schema-versioned JSON record in a plain KV store; a corrupt or stale-schema
 * record is discarded, never repaired. The credential does NOT live here:
 * Keychain owns secrets, this store is disposable cache.
 */
/* v2 (#591): the snapshot now carries `asks` — a cold launch while the Mac
   is unreachable must list the last-known requests (marked "last known"),
   never an "All clear" empty state. v1 records are dropped whole, not
   migrated — the first connect re-seeds the directory anyway. */
export const DEVICE_CACHE_SCHEMA_VERSION = 2;

/** Everything Home needs to render + resume replay, in one record. */
export const CachedDirectory = z.object({
  schemaVersion: z.literal(DEVICE_CACHE_SCHEMA_VERSION),
  /** Epoch ms the snapshot was taken. */
  savedAt: z.int().min(0),
  employees: z.array(Employee),
  channels: z.array(AppChannel),
  conversations: z.array(Conversation),
  conversationSummaries: z.array(ConversationSummary),
  profile: ProfileSettings,
  /** Last-known asks (open AND resolved) — refreshed by `asks.list` on the
      next connect; offline they're all Activity has to show. */
  asks: z.array(Ask),
  /** channelId -> last applied seq; seeds `channel.subscribe { afterSeq }`. */
  watermarks: z.record(z.string(), z.int().min(0)),
});
export type CachedDirectory = z.infer<typeof CachedDirectory>;

/** Platform KV — AsyncStorage on RN, any string map elsewhere. */
export interface DeviceCacheKV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class DeviceCache {
  constructor(
    private readonly kv: DeviceCacheKV,
    private readonly key = "lilos.directory.v1",
  ) {}

  /**
   * Load the last directory snapshot. Missing, unparseable, or wrong-schema
   * records all read as "no cache" (and the bad bytes are dropped) — the app
   * falls back to a normal connect without blocking launch.
   */
  async load(): Promise<CachedDirectory | null> {
    let raw: string | null;
    try {
      raw = await this.kv.getItem(this.key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      return CachedDirectory.parse(JSON.parse(raw));
    } catch {
      await this.kv.removeItem(this.key).catch(() => {});
      return null;
    }
  }

  async save(directory: CachedDirectory): Promise<void> {
    await this.kv.setItem(this.key, JSON.stringify(directory));
  }

  async clear(): Promise<void> {
    await this.kv.removeItem(this.key);
  }
}

/* #591 AC-3: per-conversation message history so a thread opened while the
   Mac is unreachable still shows the cached transcript. A separate KV key
   from the directory snapshot — a bad record or a schema bump here must
   never cost Home its directory, and vice versa. */
export const MESSAGES_CACHE_SCHEMA_VERSION = 1;
/** Tail cap per conversation: the offline thread reads newest-first, the
    early history isn't worth the JSON size. */
const MESSAGES_CACHE_TAIL = 200;
/** LRU bound: keep transcripts for the most recently opened threads. */
const MESSAGES_CACHE_CONVERSATIONS = 25;

export const CachedMessages = z.object({
  schemaVersion: z.literal(MESSAGES_CACHE_SCHEMA_VERSION),
  savedAt: z.int().min(0),
  /** conversationId -> seq-ordered transcript. */
  messages: z.record(z.string(), z.array(AppMessage)),
  /** conversationId -> touch order (values of `clock`), for LRU pruning. */
  touched: z.record(z.string(), z.int().min(0)),
  /** Monotone counter — Date.now() ties would make pruning arbitrary. */
  clock: z.int().min(0),
});
export type CachedMessages = z.infer<typeof CachedMessages>;

export class MessageCache {
  constructor(
    private readonly kv: DeviceCacheKV,
    private readonly key = "lilos.messages.v1",
  ) {}

  /** The cached transcript for one thread; null when nothing is stored. */
  async get(conversationId: string): Promise<AppMessage[] | null> {
    const record = await this.load();
    const messages = record?.messages[conversationId];
    if (!messages?.length) return null;
    /* A read is a use — keep the thread out of the next prune. */
    if (record) {
      record.touched[conversationId] = ++record.clock;
      await this.save(record).catch(() => {});
    }
    return messages;
  }

  async set(conversationId: string, messages: AppMessage[]): Promise<void> {
    const record = (await this.load()) ?? {
      schemaVersion: MESSAGES_CACHE_SCHEMA_VERSION,
      savedAt: 0,
      messages: {},
      touched: {},
      clock: 0,
    };
    record.messages[conversationId] = messages.slice(-MESSAGES_CACHE_TAIL);
    record.touched[conversationId] = ++record.clock;
    const ids = Object.keys(record.touched);
    if (ids.length > MESSAGES_CACHE_CONVERSATIONS) {
      ids.sort((a, b) => record.touched[b] - record.touched[a]);
      for (const id of ids.slice(MESSAGES_CACHE_CONVERSATIONS)) {
        delete record.messages[id];
        delete record.touched[id];
      }
    }
    record.savedAt = Date.now();
    await this.save(record);
  }

  private async load(): Promise<CachedMessages | null> {
    let raw: string | null;
    try {
      raw = await this.kv.getItem(this.key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      return CachedMessages.parse(JSON.parse(raw));
    } catch {
      await this.kv.removeItem(this.key).catch(() => {});
      return null;
    }
  }

  private async save(record: CachedMessages): Promise<void> {
    await this.kv.setItem(this.key, JSON.stringify(record));
  }

  async clear(): Promise<void> {
    await this.kv.removeItem(this.key);
  }
}
