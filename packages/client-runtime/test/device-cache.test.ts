import type { Employee } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  type CachedDirectory,
  DEVICE_CACHE_SCHEMA_VERSION,
  DeviceCache,
} from "../src/device-cache";

/** #154 AC-2/AC-6: the on-device directory snapshot — cache first, drop corrupt. */

function memoryKV() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: async (k: string) => {
      map.delete(k);
    },
  };
}

const EMPLOYEE: Employee = {
  id: "emp_1",
  name: "Ada",
  role: "eng",
  status: "online",
  profile: "default",
  model: "claude",
  now: "Working on LilOS",
  instructions: "",
  respondTo: "anyone",
  createdAt: 1_700_000_000_000,
};

const SNAPSHOT: CachedDirectory = {
  schemaVersion: DEVICE_CACHE_SCHEMA_VERSION,
  savedAt: 1_700_000_000_000,
  employees: [EMPLOYEE],
  channels: [
    { id: "ch_1", kind: "dm", employeeId: "emp_1", lastSeq: 7, createdAt: 1 },
  ],
  conversations: [],
  conversationSummaries: [],
  profile: { userName: "Oscar" },
  watermarks: { ch_1: 7 },
};

describe("DeviceCache (#154)", () => {
  it("AC-2 round-trips a directory snapshot incl. seq watermarks", async () => {
    const kv = memoryKV();
    const cache = new DeviceCache(kv);
    await cache.save(SNAPSHOT);
    const loaded = await cache.load();
    expect(loaded).toEqual(SNAPSHOT);
    expect(loaded?.watermarks.ch_1).toBe(7);
  });

  it("AC-2 a corrupt record reads as no cache and is dropped", async () => {
    const kv = memoryKV();
    await kv.setItem("lilos.directory.v1", "{not json!!!");
    const cache = new DeviceCache(kv);
    expect(await cache.load()).toBeNull();
    expect(kv.map.has("lilos.directory.v1")).toBe(false);
  });

  it("AC-2 a stale schema version reads as no cache", async () => {
    const kv = memoryKV();
    await kv.setItem(
      "lilos.directory.v1",
      JSON.stringify({ ...SNAPSHOT, schemaVersion: 0 }),
    );
    const cache = new DeviceCache(kv);
    expect(await cache.load()).toBeNull();
  });

  it("AC-6 clear removes the snapshot", async () => {
    const kv = memoryKV();
    const cache = new DeviceCache(kv);
    await cache.save(SNAPSHOT);
    await cache.clear();
    expect(await cache.load()).toBeNull();
  });

  it("missing key loads null", async () => {
    const cache = new DeviceCache(memoryKV());
    expect(await cache.load()).toBeNull();
  });
});
