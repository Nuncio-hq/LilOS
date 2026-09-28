import {
  type CachedDirectory,
  ConnectionSupervisor,
  RelayClient,
  type SupervisedConnection,
} from "@lilos/client-runtime";
import type { WelcomeResult } from "@lilos/contracts/app";
import type { MacLink } from "@lilos/ui-native";
import NetInfo from "@react-native-community/netinfo";
import { atom } from "nanostores";
import { AppState, type AppStateStatus } from "react-native";
import { directoryCache } from "./cache";
import { type PairedMac, touchMac } from "./paired-macs";

/**
 * The real-relay link (#154): one RelayClient, one ConnectionSupervisor —
 * nothing else ever dials. RN glue stays in this file: AppState feeds
 * `appForegrounded(backgroundedMs)`, NetInfo feeds `setOnline`, and the
 * supervisor's state atom maps onto the UI's three-word MacLink.
 *
 * Cache-first (AC-2): `startLink` hydrates the client from the on-device
 * snapshot BEFORE the first attempt fires, so Home renders the last visit
 * while the socket opens; `afterSeq` replay then catches up and the atoms
 * re-render. Snapshot writes are debounced (1.5s trailing) so chatty atom
 * updates batch into one AsyncStorage write.
 */

interface MobileLease extends SupervisedConnection {
  client: RelayClient;
}

export const $client = atom<RelayClient | undefined>(undefined);
export const $link = atom<MacLink>("reconnecting");
/** supervisor.state.lastError — surfaced under the offline banner's Details. */
export const $linkError = atom<string | undefined>(undefined);
export const $welcome = atom<WelcomeResult | undefined>(undefined);
/** RTT of the last successful keep-alive probe (Mac sheet). */
export const $latencyMs = atom<number | undefined>(undefined);

let supervisor: ConnectionSupervisor | undefined;
let backgroundedAt: number | undefined;
let detach: (() => void) | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const wsUrl = (host: string) => `ws://${host}/ws`;

export function currentSupervisor(): ConnectionSupervisor | undefined {
  return supervisor;
}

/** Cold launch + every later launch: cache hydrate first, then dial. */
export function startLink(mac: PairedMac, cached?: CachedDirectory): void {
  stopLink();
  backgroundedAt = undefined;

  const client = new RelayClient({
    url: wsUrl(mac.host),
    device: { deviceId: mac.deviceId, credential: mac.credential },
    client: { name: "ios" },
    // The supervisor is the only retry owner — the client never self-retries.
    autoReconnect: false,
  });
  if (cached) client.hydrate(cached);
  $client.set(client);

  const sv = new ConnectionSupervisor({
    connect: async (signal) => {
      const onAbort = () => client.close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        $welcome.set(await client.connect());
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const lease: MobileLease = {
        client,
        closed: new Promise((resolve) => {
          const unsub = client.state.listen((state) => {
            if (state === "closed") {
              unsub();
              resolve(undefined);
            }
          });
        }),
        close: () => client.close(),
      };
      return lease;
    },
    probe: async (connection) => {
      const c = (connection as MobileLease).client;
      const started = Date.now();
      await c.ping();
      $latencyMs.set(Date.now() - started);
    },
  });
  supervisor = sv;

  // supervisor phase -> the UI's three words. backoff/offline/blocked all
  // read "Can't reach <Mac>" on Home — reconnecting is reserved for an open
  // attempt so the banner never flickers during a healthy reconnect.
  const unsubLink = sv.state.listen((s) => {
    $linkError.set(s.lastError);
    if (s.phase === "connected") {
      $link.set("online");
      void touchMac(mac.id);
    } else if (s.phase === "connecting") {
      $link.set("reconnecting");
    } else {
      $link.set("offline");
    }
  });

  // Foreground wake: probe-or-replace lives in the supervisor; we only owe
  // it the background duration.
  const appStateSub = AppState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      if (next === "active") {
        sv.appForegrounded(
          backgroundedAt === undefined ? 0 : Date.now() - backgroundedAt,
        );
        backgroundedAt = undefined;
      } else {
        backgroundedAt = Date.now();
      }
    },
  );
  const netInfoSub = NetInfo.addEventListener((state) => {
    // `isConnected === null` means "unknown" — stay optimistic, the attempt
    // itself is the real check.
    sv.setOnline(state.isConnected !== false);
  });

  // Persist the directory snapshot on any atom change, debounced.
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void directoryCache.save(client.snapshot()).catch(() => {});
    }, 1_500);
  };
  const unsubs = [
    client.employees.listen(persist),
    client.channels.listen(persist),
    client.conversations.listen(persist),
    client.conversationSummaries.listen(persist),
    client.profile.listen(persist),
    unsubLink,
  ];

  detach = () => {
    appStateSub.remove();
    netInfoSub();
    for (const u of unsubs) u();
    if (persistTimer) clearTimeout(persistTimer);
  };

  sv.connect();
}

export function stopLink(): void {
  detach?.();
  detach = undefined;
  supervisor?.dispose();
  supervisor = undefined;
  $client.get()?.close();
  $client.set(undefined);
  $link.set("reconnecting");
  $linkError.set(undefined);
  $welcome.set(undefined);
  $latencyMs.set(undefined);
}
