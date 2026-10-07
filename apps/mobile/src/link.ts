import {
  type AppClient,
  type CachedDirectory,
  ConnectionSupervisor,
  RelayClient,
  RelayError,
  type SupervisedConnection,
  type SupervisorState,
} from "@lilos/client-runtime";
import { HostChangedEvent, type WelcomeResult } from "@lilos/contracts/app";
import type { MacLink } from "@lilos/ui-native";
import NetInfo from "@react-native-community/netinfo";
import { atom } from "nanostores";
import { AppState, type AppStateStatus } from "react-native";
import { directoryCache } from "./cache";
import { type BlockedUpdate, blockedUpdateFor } from "./mapping";
import { type PairedMac, removedByMac, touchMac } from "./paired-macs";

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

/* The client interface screens consume (#168): a live RelayClient or the
   fully-offline demo world — same atoms, same request surface. */
export const $client = atom<AppClient | undefined>(undefined);
export const $link = atom<MacLink>("reconnecting");
/** supervisor.state.lastError — surfaced under the offline banner's Details. */
export const $linkError = atom<string | undefined>(undefined);
/** #597: which side a version-mismatch says is stale — drives the blocked
   state's "Update LilOS on this iPhone / on the Mac" line. Undefined both
   for "not blocked" and "blocked but can't read the update side". */
export const $blockedUpdate = atom<BlockedUpdate | undefined>(undefined);
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

/** supervisor phase -> the UI's words. `backoff`/`offline` all read
   "Can't reach <Mac>" — and so does a retry `connecting` once a failure
   has landed (`lastError` set): the banner appears with the first failure
   and holds through every retry instead of blinking off per attempt
   (#591 AC-1). `reconnecting` stays reserved for a never-failed attempt —
   a cold launch or a healthy-session reconnect — so the banner never
   flickers before anything has actually gone wrong. `blocked` (fatal:
   protocol_version_mismatch) is its own word (#597 AC-2) — it's an update
   prompt, not a reach problem. */
export function macLinkFor(s: SupervisorState): MacLink {
  if (s.phase === "connected") return "online";
  if (s.phase === "blocked") return "blocked";
  if (s.phase === "connecting" && s.lastError === undefined)
    return "reconnecting";
  return "offline";
}

/** #597: the socket is dead in both words — `offline` (retrying) and
   `blocked` (fatal: version mismatch). Screens that mark stale rows and
   mute sends should treat them alike. */
export const linkUnreachable = (link: MacLink): boolean =>
  link === "offline" || link === "blocked";

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

  /* #482: engine-state flips must reach the Mac sheet live — the relay
     broadcasts `host.changed {connected, engine:{state,detail}}` on every
     harness.report state flip; patch `welcome.engineHost` so the sheet
     shows restarting/failed during an outage instead of the state frozen
     at link time. */
  client.onEvent((method, params) => {
    if (method !== "host.changed") return;
    const event = HostChangedEvent.safeParse(params);
    if (!event.success) return;
    const w = $welcome.get();
    const eh = w?.engineHost;
    if (!w || !eh) return;
    $welcome.set({
      ...w,
      engineHost: {
        ...eh,
        connected: event.data.connected,
        ...(event.data.engine
          ? {
              state: event.data.engine.state,
              /* detail clears with the state — a recovered "running" row
                 must not keep wearing the last outage's reason. */
              detail: event.data.engine.detail,
            }
          : {}),
      },
    });
  });

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
              resolve(client.lastSocketError);
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
    onFatalError: (error) => {
      /* #597: a version mismatch keeps the pairing — block with the side
         to update so the UI says "Update LilOS on this iPhone / on the
         Mac" instead of "Can't reach it". */
      if (
        error instanceof RelayError &&
        error.code === "protocol_version_mismatch"
      ) {
        $blockedUpdate.set(blockedUpdateFor(error));
        return;
      }
      /* The Mac revoked this phone (socket closed 4403) or won't take the
         stored credential at hello — the pairing is dead either way: drop
         it and send the user back to pair instead of retrying forever. */
      if (
        error instanceof RelayError &&
        (error.code === "device_revoked" || error.code === "unauthenticated")
      ) {
        stopLink();
        void removedByMac(() => directoryCache.clear());
      }
    },
  });
  supervisor = sv;

  const unsubLink = sv.state.listen((s) => {
    $linkError.set(s.lastError);
    $link.set(macLinkFor(s));
    if (s.phase === "connected") {
      $blockedUpdate.set(undefined);
      void touchMac(mac.id);
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
    client.asks.listen(persist),
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
  $blockedUpdate.set(undefined);
  $welcome.set(undefined);
  $latencyMs.set(undefined);
}
