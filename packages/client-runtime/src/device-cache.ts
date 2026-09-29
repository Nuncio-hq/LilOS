import {
  AppChannel,
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
export const DEVICE_CACHE_SCHEMA_VERSION = 1;

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
