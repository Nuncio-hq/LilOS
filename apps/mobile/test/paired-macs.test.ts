import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory Keychain stand-in — paired-macs talks only get/set/delete. */
const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStore.delete(key);
  },
}));

import {
  $connections,
  $pairNotice,
  $phase,
  fallbackName,
  hydrateConnections,
  type PairedMac,
  removedByMac,
  savePairedMac,
} from "../src/paired-macs";

const KEY = "lilos.connections.v1";

const mac: PairedMac = {
  id: "dev_1",
  name: "Office Mac",
  host: "office-mac.tail0000.ts.net:4577",
  route: "tailscale",
  pairedAt: 1,
  lastSeenAt: 1,
  deviceId: "dev_1",
  credential: "devcred_test",
};

describe("paired-macs (#154)", () => {
  beforeEach(() => {
    secureStore.clear();
    $connections.set([]);
    $pairNotice.set(undefined);
    $phase.set("loading");
  });

  it("removedByMac clears the credential, flips to onboarding, and leaves a notice", async () => {
    await savePairedMac(mac);
    $phase.set("app");
    let cleared = false;

    // The supervisor's fatal path after a ws 4403 / refused credential.
    await removedByMac(async () => {
      cleared = true;
    });

    expect($pairNotice.get()).toBe("This Mac removed this phone. Pair again.");
    expect($connections.get()).toEqual([]);
    expect($phase.get()).toBe("onboarding");
    expect(secureStore.has(KEY)).toBe(false);
    expect(cleared).toBe(true);

    // A cold launch after the revoke lands on onboarding, not the dead mac.
    await hydrateConnections();
    expect($phase.get()).toBe("onboarding");
  });

  it("savePairedMac clears a stale removal notice on the next pairing", async () => {
    await removedByMac(async () => {});
    expect($pairNotice.get()).toBeDefined();

    await savePairedMac(mac);
    expect($pairNotice.get()).toBeUndefined();
    expect($connections.get()).toHaveLength(1);
  });
});

/* #688 AC-2 — an IP is never a Mac's name. */
describe("fallbackName (#688)", () => {
  it.each([
    "172.16.4.2",
    "172.16.4.2:4577",
    "172",
    "localhost",
    "localhost:4577",
    "::1",
    "[::1]:4577",
  ])("host %s falls back to the generic name", (host) => {
    expect(fallbackName(host)).toBe("Your Mac");
  });

  it("a tailnet name keeps its first label", () => {
    expect(fallbackName("oscars-mac.tail0000.ts.net")).toBe("oscars-mac");
    expect(fallbackName("oscars-mac.tail0000.ts.net:4577")).toBe("oscars-mac");
  });
});
