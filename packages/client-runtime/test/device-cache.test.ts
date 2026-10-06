import type { AppMessage, Ask, Employee } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  type CachedDirectory,
  DEVICE_CACHE_SCHEMA_VERSION,
  DeviceCache,
  MessageCache,
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
  asks: [],
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

  it("AC-2 asks ride the snapshot so Activity keeps the last-known list offline (#591)", async () => {
    const kv = memoryKV();
    const cache = new DeviceCache(kv);
    const ask: Ask = {
      id: "ask_1",
      channelId: "ch_1",
      conversationId: "conv_1",
      turnId: "t_1",
      requestId: "r_1",
      request: {
        kind: "approval",
        command: "patch README.md",
        options: ["once", "session", "always", "deny"],
      },
      state: "open",
      createdAt: 1_700_000_000_000,
    };
    await cache.save({ ...SNAPSHOT, asks: [ask] });
    const loaded = await cache.load();
    expect(loaded?.asks).toEqual([ask]);
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

const MSG = (id: string, seq: number): AppMessage => ({
  id,
  channelId: "ch_1",
  authorId: "user",
  conversationId: "conv_1",
  authorKind: "user",
  text: `message ${id}`,
  seq,
  createdAt: 1_700_000_000_000 + seq,
  rewound: false,
  dropped: false,
  removed: false,
  claimed: false,
});

describe("MessageCache (#591 AC-3)", () => {
  it("round-trips a conversation transcript", async () => {
    const cache = new MessageCache(memoryKV());
    const transcript = [MSG("m1", 1), MSG("m2", 2)];
    await cache.set("conv_1", transcript);
    expect(await cache.get("conv_1")).toEqual(transcript);
  });

  it("reads null for a thread never cached", async () => {
    const cache = new MessageCache(memoryKV());
    await cache.set("conv_1", [MSG("m1", 1)]);
    expect(await cache.get("conv_9")).toBeNull();
  });

  it("a corrupt record reads as no cache and is dropped", async () => {
    const kv = memoryKV();
    await kv.setItem("lilos.messages.v1", "{not json!!!");
    const cache = new MessageCache(kv);
    expect(await cache.get("conv_1")).toBeNull();
    expect(kv.map.has("lilos.messages.v1")).toBe(false);
  });

  it("tail-caps each transcript at 200 messages", async () => {
    const cache = new MessageCache(memoryKV());
    const transcript = Array.from({ length: 210 }, (_, i) =>
      MSG(`m${i}`, i + 1),
    );
    await cache.set("conv_1", transcript);
    const cached = await cache.get("conv_1");
    expect(cached).toHaveLength(200);
    expect(cached?.[0].id).toBe("m10");
  });

  it("prunes to the 25 most recently touched conversations", async () => {
    const cache = new MessageCache(memoryKV());
    for (let i = 0; i < 26; i++) {
      await cache.set(`conv_${i}`, [MSG(`m${i}`, i + 1)]);
    }
    expect(await cache.get("conv_0")).toBeNull();
    expect(await cache.get("conv_25")).not.toBeNull();
    /* a read re-touches: conv_1 survives the next prune, conv_2 falls out */
    expect(await cache.get("conv_1")).not.toBeNull();
    await cache.set("conv_26", [MSG("m26", 1)]);
    expect(await cache.get("conv_2")).toBeNull();
    expect(await cache.get("conv_1")).not.toBeNull();
  });
});
