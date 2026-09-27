import * as SecureStore from "expo-secure-store";
import { atom } from "nanostores";

/* Paired Macs. The UI shows one Mac for now, but connections are a list keyed
   by id so a second Mac (or a cloud route) is additive, not a migration.
   Stored in the Keychain via SecureStore because the real entry will carry the
   per-device credential the Mac issues at pairing (backend slice). */

export type Route = "tailscale" | "local";

export type PairedMac = {
  id: string;
  name: string;
  host: string;
  route: Route;
  pairedAt: number;
  /** Last time the phone reached this Mac (ms). */
  lastSeenAt: number;
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

export async function forgetMacs(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
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

/** "oscars-macbook-pro.tail1a2b.ts.net" → "oscars-macbook-pro" when the QR had no name. */
export function fallbackName(host: string): string {
  return host.split(".")[0]?.split(":")[0] || host;
}
