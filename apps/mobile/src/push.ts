import type { PushPrefs } from "@lilos/contracts/app";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { atom } from "nanostores";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { $demo } from "./demo/lifecycle";
import { deepThreadTarget } from "./home-model";
import { $client, $link } from "./link";
import { $phase } from "./paired-macs";
import { nav } from "./routes";

/**
 * Expo push on the phone (#161): the relay sends one push when a thread
 * turns needs-you / done / failed; this module owns the phone's half —
 *
 * - `push.register`: after pairing and on every foreground while online,
 *   the Expo token + the four per-kind toggles are upserted to the relay,
 *   keyed by the device id the socket already authenticated (AC-1).
 * - Tap → thread: the payload's `conversationId` navigates to Thread —
 *   `getLastNotificationResponseAsync` covers the cold start, the response
 *   listener covers a live app; either way the tap queues until the app's
 *   navigator is up (AC-4).
 * - Foreground presentation is suppressed entirely: the NeedsYou slot and
 *   the thread itself already surface it in-app — an iOS banner on top
 *   would double-notify (the per-thread suppression is the relay's job,
 *   reported via `push.visibility` in `visibility.ts`).
 * - Forget this Mac sends `push.unregister` before the socket dies (the
 *   relay also drops the row on `devices.revoke`, so either order works).
 */

const PREFS_KEY = "lilos.push.prefs.v1";

const DEFAULT_PUSH_PREFS: PushPrefs = {
  needsApproval: true,
  waitingForInput: true,
  completed: true,
  failed: true,
};

/** The four toggles + the OS permission, for the Settings section (AC-6). */
export const $pushPrefs = atom<PushPrefs>(DEFAULT_PUSH_PREFS);
export const $pushPermission = atom<"undetermined" | "denied" | "granted">(
  "undetermined",
);

let started = false;
/** A tapped push awaiting its navigator (cold start before `phase==="app"`). */
let pendingThread: { conversationId: string; employeeId?: string } | undefined;

const readPermission = async (): Promise<
  "undetermined" | "denied" | "granted"
> => {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync();
  if (status === "granted") return "granted";
  // iOS lets us ask once; after that only Settings can flip it.
  return canAskAgain ? "undetermined" : "denied";
};

const refreshPermission = async () => {
  $pushPermission.set(await readPermission());
};

const persistPrefs = async (prefs: PushPrefs) => {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
};

/** AC-1: token + prefs upsert. No token (no entitlement, Expo unreachable)
    → nothing registered — registration is what arms pushes on this device.
    Tried everywhere: iOS 16+ simulators can register too. The OS permission
    is only worth asking once paired and online, so the undetermined ask
    rides this path rather than cold boot; the Settings row is the manual
    trigger before that. */
const register = async (): Promise<void> => {
  const client = $client.get();
  /* The demo marks the link "online" for chrome, but never owns a device —
     no permission prompt, no token round-trip (#168). */
  if (!client || $link.get() !== "online" || $demo.get()) return;
  await refreshPermission();
  await requestPushPermission();
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const token = (
      await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      )
    ).data;
    await client.request("push.register", {
      token,
      prefs: $pushPrefs.get(),
    });
  } catch {
    // No token (EAS project id unset, Expo unreachable) — pushes are simply
    // off for this device; the toggles keep working for the next attempt.
  }
};

/** AC-6: a toggle flips locally (persisted), then re-registers so the
    relay-side prefs follow. */
export const setPushPref = async (
  key: keyof PushPrefs,
  value: boolean,
): Promise<void> => {
  const next = { ...$pushPrefs.get(), [key]: value };
  $pushPrefs.set(next);
  await persistPrefs(next);
  await register();
};

/** Forget this Mac: best-effort unregister on the live socket before it
    goes away; the revoke path is the backstop. */
export const unregisterPush = async (): Promise<void> => {
  const client = $client.get();
  if (!client || $link.get() !== "online") return;
  await client.request("push.unregister", {}).catch(() => {});
};

/** Ask iOS for the permission — first run only; after that the Settings
    row steers to the OS page. #600: say WHY first — the system dialog
    fires with no context straight after pairing otherwise. */
export const requestPushPermission = async (): Promise<void> => {
  if ($pushPermission.get() !== "undetermined") return;
  const go = await new Promise<boolean>((resolve) => {
    Alert.alert(
      "Get notified",
      "LilOS can tell you when a thread finishes or needs you.",
      [
        {
          text: "Not now",
          style: "cancel",
          onPress: () => resolve(false),
        },
        { text: "Continue", onPress: () => resolve(true) },
      ],
    );
  });
  if (!go) return;
  await Notifications.requestPermissionsAsync().catch(() => {});
  await refreshPermission();
};

/* #596 AC-1: the thread opens pushed over its own DM — Back returns to the
   DM, the same landing an ask's Open/Review takes. The employee resolves
   from the wire: a hydrated cache resolves at cold start, a thread created
   while the app was closed resolves once the first sync lands. */
const pushThread = (conversationId: string, payloadEmployeeId?: string) => {
  const client = $client.get();
  const target =
    client &&
    deepThreadTarget(conversationId, {
      conversations: client.conversations.get(),
      channels: client.channels.get(),
    });
  /* AC-2b: the wire resolution wins when it exists; the payload's own
     employeeId is the fallback — the only id a gone-by-tap-time thread
     can still name. Either way the DM stacks under the Thread and the
     gone card's "Back to <employee>" has somewhere to land. */
  const employeeId = target?.employeeId ?? payloadEmployeeId;
  if (employeeId) nav.navigate("Dm", { employeeId });
  nav.navigate("Thread", {
    conversationId,
    ...(employeeId ? { employeeId } : {}),
  });
};

/* The tap waits only for what the DM needs: resolvable now, or the first
   directory sync concluded (a miss still opens — the thread's own "gone"
   state is the answer), or the link already gave up. */
const threadTargetReady = (conversationId: string): boolean => {
  const client = $client.get();
  if (!client) return true;
  if (
    deepThreadTarget(conversationId, {
      conversations: client.conversations.get(),
      channels: client.channels.get(),
    })
  ) {
    return true;
  }
  return client.directoryReady.get() || $link.get() === "offline";
};

const openPushThread = (
  conversationId: string | undefined,
  payloadEmployeeId?: string,
) => {
  if (!conversationId) return;
  if (
    nav.isReady() &&
    $phase.get() === "app" &&
    /* A payload that already names its employee needs no wire
       resolution — open at once and let the thread's own states answer
       whether it still exists. */
    (payloadEmployeeId || threadTargetReady(conversationId))
  ) {
    pushThread(conversationId, payloadEmployeeId);
  } else {
    /* Cold start, mid-onboarding, or still syncing: hold it until the
       stack — and the DM underneath it — can be pushed. */
    pendingThread = {
      conversationId,
      ...(payloadEmployeeId ? { employeeId: payloadEmployeeId } : {}),
    };
  }
};

const drainPendingThread = () => {
  if (
    pendingThread &&
    nav.isReady() &&
    $phase.get() === "app" &&
    (pendingThread.employeeId !== undefined ||
      threadTargetReady(pendingThread.conversationId))
  ) {
    const held = pendingThread;
    pendingThread = undefined;
    pushThread(held.conversationId, held.employeeId);
  }
};

/** Called once from App: prefs hydrate, the in-app handler is silenced, the
    tap path arms, and register/permission track the link + foreground. */
export function initPush(): void {
  if (started) return;
  started = true;

  void (async () => {
    const raw = await AsyncStorage.getItem(PREFS_KEY).catch(() => null);
    if (raw) {
      try {
        $pushPrefs.set({ ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) });
      } catch {
        /* a stale blob falls back to defaults */
      }
    }
    await refreshPermission();
    // No permission ask here: before pairing there's nothing to notify
    // about, so the undetermined Settings row stays reachable until the
    // register() path asks once the link is up.
    await register();
  })();

  // In-app banner off: the NeedsYou slot/thread UI already surfaces it.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: false,
      shouldShowList: false,
    }),
  });

  const responseSub = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data;
      openPushThread(
        typeof data?.conversationId === "string"
          ? data.conversationId
          : undefined,
        typeof data?.employeeId === "string" ? data.employeeId : undefined,
      );
    },
  );
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const data = response?.notification.request.content.data;
    openPushThread(
      typeof data?.conversationId === "string"
        ? data.conversationId
        : undefined,
      typeof data?.employeeId === "string" ? data.employeeId : undefined,
    );
  });

  const linkSub = $link.listen((state) => {
    if (state === "online") void register();
    /* #596: every link flip re-drains — offline is a drain signal too
       (a held tap opens Thread alone rather than waiting forever). */
    drainPendingThread();
  });
  /* #596: the DM under the thread only exists once the first directory
     sync lands — re-drain when it does. `.subscribe` fires the current
     value immediately, so a client that already exists still arms it. */
  const clientSub = $client.subscribe((client) => {
    client?.directoryReady.listen(drainPendingThread);
  });
  // The stack re-mounts on the onboarding→app phase flip, so nav state
  // alone doesn't cover it — drain once the app phase lands too.
  const phaseSub = $phase.listen(drainPendingThread);
  const navSub = nav.addListener("state", drainPendingThread);
  const appStateSub = AppState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      if (next === "active") {
        void refreshPermission();
        void register();
        drainPendingThread();
      }
    },
  );

  // The module never un-registers its listeners — the app lives as long as
  // the process; held for tests/hot-reload symmetry.
  void responseSub;
  void linkSub;
  void clientSub;
  void phaseSub;
  void navSub;
  void appStateSub;
}
