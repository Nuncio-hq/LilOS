import type { SupervisorState } from "@lilos/client-runtime";
import { describe, expect, it, vi } from "vitest";

/* #591 AC-1/AC-4: the supervisor phase -> MacLink mapping. Once any attempt
   has failed (`lastError` is set) every later phase — the retry `connecting`
   window included — reads `offline`, so Home's "Can't reach <Mac>" banner
   lands with the first failure and holds through retries instead of
   blinking on and off with each attempt. Only a never-failed attempt reads
   `reconnecting`, so a cold launch and a healthy reconnect stay quiet. */

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
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
}));

import { macLinkFor } from "../src/link";

const st = (
  phase: SupervisorState["phase"],
  lastError?: string,
): SupervisorState => ({
  phase,
  attempt: 1,
  ...(lastError === undefined ? {} : { lastError }),
});

describe("macLinkFor (#591)", () => {
  it("connected reads online", () => {
    expect(macLinkFor(st("connected"))).toBe("online");
  });

  it("a clean attempt (no failure yet) reads reconnecting — no banner flicker", () => {
    expect(macLinkFor(st("connecting"))).toBe("reconnecting");
  });

  it("a retry attempt after a failure stays offline — the banner holds", () => {
    expect(macLinkFor(st("connecting", "socket_closed"))).toBe("offline");
  });

  it("backoff between retries reads offline", () => {
    expect(macLinkFor(st("backoff", "connect timeout"))).toBe("offline");
  });

  it("offline (no network) and blocked (fatal) read offline", () => {
    expect(macLinkFor(st("offline", "no network"))).toBe("offline");
    expect(macLinkFor(st("blocked", "unauthenticated"))).toBe("offline");
  });

  it("idle reads offline — a disconnected Mac is not a live one", () => {
    expect(macLinkFor(st("idle"))).toBe("offline");
  });
});
