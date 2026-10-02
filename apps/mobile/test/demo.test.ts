import type { AppClient } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #168 AC-6: the demo data source never opens a socket or hits the network —
   these tests run the whole world (connect, a threaded turn, an approve and
   a deny, a scripted answer) with WebSocket/fetch/XHR stubbed to throw, plus
   the AppClient conformance and exitDemo's clean slate. */

const secureStore = vi.hoisted(() => new Map<string, string>());
const asyncStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStore.delete(key);
  },
}));

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

vi.mock("@react-native-community/netinfo", () => ({
  default: {
    addEventListener: () => () => {},
    fetch: async () => ({ isConnected: true }),
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  Alert: { alert: () => {} },
}));

import { DemoClient } from "../src/demo/client";
import { $demo, enterDemo, exitDemo } from "../src/demo/lifecycle";
import { $asks, $folders, $wbCards, watchDm } from "../src/dm-store";
import { $client, $link, $welcome } from "../src/link";
import { $phase } from "../src/paired-macs";
import { $prs as $prsStore } from "../src/prs";

/** Swap the real network surfaces for traps — any accidental dial throws. */
function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const ws = vi.fn(() => {
    throw new Error("demo opened a WebSocket");
  });
  const fetchSpy = vi.fn(() => {
    throw new Error("demo called fetch");
  });
  const xhr = vi.fn(() => {
    throw new Error("demo opened an XMLHttpRequest");
  });
  const orig = {
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    XMLHttpRequest: globalThis.XMLHttpRequest,
  };
  globalThis.WebSocket = ws as never;
  globalThis.fetch = fetchSpy as never;
  globalThis.XMLHttpRequest = xhr as never;
  return fn().finally(() => {
    globalThis.WebSocket = orig.WebSocket;
    globalThis.fetch = orig.fetch;
    globalThis.XMLHttpRequest = orig.XMLHttpRequest;
    expect(ws).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });
}

const client = () => new DemoClient();

describe("demo data source (#168)", () => {
  beforeEach(() => {
    exitDemo();
  });

  it("conforms to the AppClient surface screens consume", async () => {
    const c: AppClient = client();
    for (const member of [
      "state",
      "employees",
      "channels",
      "conversations",
      "conversationSummaries",
      "profile",
      "asks",
      "devices",
      "directoryReady",
      "fatal",
      "rewinds",
      "status",
      "connect",
      "close",
      "ping",
      "request",
      "channelMessages",
      "sessionFeed",
      "unsubscribeChannel",
      "onEvent",
      "hydrate",
      "snapshot",
      "listModels",
    ] as const) {
      expect(c[member], member).toBeDefined();
    }
  });

  it("connects the whole world with no socket (AC-1/AC-6)", async () => {
    await noNetwork(async () => {
      const c = client();
      const welcome = await c.connect();
      expect(c.state.get()).toBe("ready");
      expect(c.directoryReady.get()).toBe(true);
      expect(welcome.engineHost?.connected).toBe(true);
      expect(c.employees.get().length).toBeGreaterThanOrEqual(4);
      expect(c.channels.get().length).toBeGreaterThanOrEqual(4);
      /* AC-1: Home has a populated company before the first paint. */
      expect(c.conversations.get().length).toBeGreaterThanOrEqual(10);
      expect(c.conversationSummaries.get().length).toBeGreaterThanOrEqual(10);
      expect(c.profile.get().companyName).toBe("LilOS Demo");
      const models = (await c.request("models.list", {})) as {
        models: unknown[];
      };
      expect(models.models.length).toBeGreaterThan(3);
      c.close();
    });
  });

  it("streams a scripted turn, then continues past an allow and a deny (AC-3)", {
    timeout: 30_000,
  }, async () => {
    await noNetwork(async () => {
      /* Allow path: the seeded flake ask resolves, the onApprove script
         plays, the turn completes and the reply lands in the thread. */
      const allow = client();
      await allow.connect();
      const feedAllow = allow.sessionFeed("s-flake");
      expect(feedAllow.get().openRequests.map((r) => r.requestId)).toContain(
        "req-a-flake",
      );
      const before = allow.channelMessages("ch-reviewer").get().messages.length;
      const res = await allow.request("asks.respond", {
        askId: "a-flake",
        outcome: "always",
      });
      expect((res as { ask: Ask }).ask.state).toBe("resolved");
      await vi.waitFor(
        () => {
          expect(feedAllow.get().snapshot?.state).toBe("idle");
        },
        { timeout: 15_000 },
      );
      expect(allow.asks.get()[0]?.outcome).toBe("always");
      expect(
        allow.channelMessages("ch-reviewer").get().messages.length,
      ).toBeGreaterThan(before);
      allow.close();

      /* Deny path: same ask, denied — the onDeny script reports it didn't
         run and the turn still completes. */
      const deny = client();
      await deny.connect();
      const feedDeny = deny.sessionFeed("s-flake");
      const denyRes = await deny.request("asks.respond", {
        askId: "a-flake",
        outcome: "deny",
      });
      expect((denyRes as { ask: Ask }).ask.outcome).toBe("deny");
      await vi.waitFor(
        () => {
          expect(feedDeny.get().snapshot?.state).toBe("idle");
        },
        { timeout: 15_000 },
      );
      deny.close();
    });
  });

  it("answers a sent message with a scripted reply (AC-3)", {
    timeout: 30_000,
  }, async () => {
    await noNetwork(async () => {
      const c = client();
      await c.connect();
      const { message } = (await c.request("messages.post", {
        channelId: "ch-builder",
        conversationId: "s-gap",
        text: "hello?",
      })) as { message: { seq: number; authorKind: string } };
      expect(message.authorKind).toBe("user");
      const store = c.channelMessages("ch-builder");
      await vi.waitFor(
        () => {
          const last = store.get().messages.at(-1);
          expect(last?.authorKind).toBe("employee");
          expect(last?.conversationId).toBe("s-gap");
        },
        { timeout: 15_000 },
      );
      c.close();
    });
  });

  it("enterDemo/exitDemo leaves nothing behind (AC-4)", async () => {
    await noNetwork(async () => {
      await enterDemo();
      expect($demo.get()).toBe(true);
      expect($phase.get()).toBe("app");
      expect($link.get()).toBe("online");
      expect($client.get()).toBeDefined();
      expect($welcome.get()?.instanceId).toBe("demo");
      /* The screen wiring (watchDm) seeds the shared atoms — the same
         path Home hits when Tabs mounts. */
      const c = $client.get();
      expect(c).toBeDefined();
      watchDm(c as AppClient);
      await vi.waitFor(() => {
        expect($asks.get().length).toBeGreaterThanOrEqual(1);
        expect($folders.get().length).toBeGreaterThanOrEqual(1);
      });
      exitDemo();
      expect($demo.get()).toBe(false);
      expect($phase.get()).toBe("onboarding");
      expect($client.get()).toBeUndefined();
      expect($welcome.get()).toBeUndefined();
      expect($asks.get()).toEqual([]);
      expect($folders.get()).toEqual([]);
      expect($prsStore.get()).toEqual({});
      expect($wbCards.get()).toEqual({});
      /* AC-4: nothing the demo did reached the Keychain or AsyncStorage —
         the mocks stayed empty through the whole enter/exit cycle. */
      expect(secureStore.size).toBe(0);
      expect(asyncStore.size).toBe(0);
    });
  });
});
