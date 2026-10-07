import { beforeEach, describe, expect, it, vi } from "vitest";

/* #556 AC-2: composer drafts are per-conversation and device-local — they
   survive leaving the thread and a full relaunch (AsyncStorage), and a
   forget/re-pair wipes them with the rest of the DM store. */

const asyncStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStore.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStore.delete(key);
    },
  },
}));

import { resetDmStore } from "../src/dm-store";
import {
  draftFor,
  loadDrafts,
  resetDrafts,
  setDraft,
} from "../src/draft-store";

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 350));
}

beforeEach(() => {
  asyncStore.clear();
  resetDrafts();
});

describe("draft store", () => {
  it("keeps a draft per key, not per screen", () => {
    setDraft("thread:c1", "half a reply");
    setDraft("thread:c2", "other thread");
    setDraft("dm:e1", "dm draft");
    expect(draftFor("thread:c1")).toBe("half a reply");
    expect(draftFor("thread:c2")).toBe("other thread");
    expect(draftFor("dm:e1")).toBe("dm draft");
    expect(draftFor("thread:nope")).toBeUndefined();
  });

  it("persists across a reload (relaunch)", async () => {
    setDraft("thread:c1", "still typing");
    await flush();
    // A fresh module instance sees what the cold app would — empty
    // memory until loadDrafts hydrates from storage.
    vi.resetModules();
    const fresh = await import("../src/draft-store");
    expect(fresh.draftFor("thread:c1")).toBeUndefined();
    await fresh.loadDrafts();
    expect(fresh.draftFor("thread:c1")).toBe("still typing");
  });

  it("clears a sent draft immediately — a kill right after send can't resurrect it", async () => {
    setDraft("thread:c1", "about to send");
    await flush();
    setDraft("thread:c1", "");
    // No debounce window for the clear.
    expect(asyncStore.get("lilos.drafts.v1")).not.toContain("about to send");
    expect(draftFor("thread:c1")).toBeUndefined();
  });

  it("resetDmStore wipes drafts (forget / demo exit)", async () => {
    setDraft("thread:c1", "gone with the Mac");
    await flush();
    resetDmStore();
    expect(draftFor("thread:c1")).toBeUndefined();
    await loadDrafts();
    expect(draftFor("thread:c1")).toBeUndefined();
  });

  it("a corrupt record loads as empty, never throws", async () => {
    asyncStore.set("lilos.drafts.v1", "{not json");
    await expect(loadDrafts()).resolves.toBeUndefined();
    expect(draftFor("thread:c1")).toBeUndefined();
  });
});
