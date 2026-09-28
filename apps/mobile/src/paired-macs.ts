import * as SecureStore from "expo-secure-store";
import { atom } from "nanostores";

/* Paired Macs (#154). The UI shows one Mac for now, but connections are a
   list keyed by id so a second Mac is additive, not a migration. The list —
   including each Mac's device credential — lives in the Keychain via
   SecureStore: the credential is the phone's long-lived auth into the relay
   (#153), and the Keychain survives app reinstalls only where the user
   opted into that (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly would
   pin it to this device; SecureStore's default already keeps it off
   backups into other phones). */

export type Route = "tailscale" | "local";

export type PairedMac = {
  /** Stable key — the relay-issued device id. */
  id: string;
  name: string;
  /** `host:port` the pairing offer advertised; dialed as `ws://host/ws`. */
  host: string;
  route: Route;
  pairedAt: number;
  /** Last time the phone reached this Mac (ms). */
  lastSeenAt: number;
  /** `session.hello` device auth (#153). */
  deviceId: string;
  credential: string;
};

export type Phase = "loading" | "onboarding" | "app";

export const $connections = atom<PairedMac[]>([]);
export const $phase = atom<Phase>("loading");

const KEY = "lilos.connections.v1";

export async function hydrateConnections(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const list = raw ? (JSON.parse(raw) as PairedMac[]) : [];
    $connections.set(list);
    $phase.set(list.length > 0 ? "app" : "onboarding");
  } catch {
    $connections.set([]);
    $phase.set("onboarding");
  }
}

async function persist(list: PairedMac[]): Promise<void> {
  $connections.set(list);
  await SecureStore.setItemAsync(KEY, JSON.stringify(list));
}

/** One Mac for now: pairing again replaces the current one. */
export async function savePairedMac(mac: PairedMac): Promise<void> {
  await persist([mac]);
}

export async function touchMac(id: string): Promise<void> {
  await persist(
    $connections
      .get()
      .map((m) => (m.id === id ? { ...m, lastSeenAt: Date.now() } : m)),
  );
}

/** AC-6: Forget drops the credential AND the cached directory. */
export async function forgetMacs(
  clearCache: () => Promise<void>,
): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
  await clearCache();
  $connections.set([]);
  $phase.set("onboarding");
}

export function routeFor(host: string): Route {
  return /\.ts\.net(:\d+)?$/.test(host) || /^100\.\d+\.\d+\.\d+/.test(host)
    ? "tailscale"
    : "local";
}

export const ROUTE_LABEL: Record<Route, string> = {
  tailscale: "via Tailscale",
  local: "on this network",
};

/** "my-mac.tail0000.ts.net" → "my-mac" when the QR had no name. */
export function fallbackName(host: string): string {
  return host.split(".")[0]?.split(":")[0] || host;
}
