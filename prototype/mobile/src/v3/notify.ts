import * as Notifications from "expo-notifications";

/**
 * Lock-screen notifications for the v3 phone prototype.
 *
 * Two kinds, both local (the fake company has no push server) but built so a
 * remote push can reuse them unchanged:
 *   - an ask ("Needs you"): category `lilos-ask`, Approve / Deny on the lock
 *     screen, data `{ askId }`;
 *   - a CEO update: no category, tap opens the CEO thread, data `{ updateId }`.
 *
 * A remote push needs `aps.category = "lilos-ask"` and the ids under a
 * top-level `body` key (expo-notifications reads `data` from `body` for
 * remote payloads); see maestro/notify/ask.apns.
 */

export type NotifyTarget =
  | { kind: "ask"; askId: string }
  | { kind: "update"; updateId: string };

export type NotifyHandlers = {
  /** Lock-screen Approve. */
  approve(askId: string): void;
  /** Lock-screen Deny. */
  deny(askId: string): void;
  /** Tapped the notification body. */
  open(target: NotifyTarget): void;
};

export const ASK_CATEGORY = "lilos-ask";
export const APPROVE_ACTION = "approve";
export const DENY_ACTION = "deny";

/** Responses already routed, keyed by notification + action. The live
    listener and the cold-start read can both see the same response (the
    listener attaches while iOS is still replaying it), and a dev reload
    re-runs `initNotifications` — without this an Approve could fire twice. */
const handled = new Set<string>();

const categoryReady = Notifications.setNotificationCategoryAsync(
  ASK_CATEGORY,
  [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: "Approve",
      /* Approving lets an agent act (spend, send, ship), so it needs the
         phone unlocked — a stranger holding it must not be able to approve.
         The action opens the app anyway: with `opensAppToForeground: false`
         iOS never reaches JS when the app was killed (expo-notifications
         docs), which would silently drop the answer. */
      options: { isAuthenticationRequired: true, opensAppToForeground: true },
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: "Deny",
      /* Red button. Denying only ever makes the agent stop, so it asks for
         no authentication of its own; it still opens the app so the answer
         reaches JS from a cold start. */
      options: {
        isDestructive: true,
        isAuthenticationRequired: false,
        opensAppToForeground: true,
      },
    },
  ],
  { showTitle: true },
);

const targetOf = (
  data: Record<string, unknown> | undefined,
): NotifyTarget | undefined => {
  if (typeof data?.askId === "string") {
    return { kind: "ask", askId: data.askId };
  }
  if (typeof data?.updateId === "string") {
    return { kind: "update", updateId: data.updateId };
  }
  return undefined;
};

const route = (
  response: Notifications.NotificationResponse,
  h: NotifyHandlers,
) => {
  const { request } = response.notification;
  const key = `${request.identifier}:${response.actionIdentifier}`;
  if (handled.has(key)) return;
  const target = targetOf(request.content.data);
  if (!target) return;
  handled.add(key);
  if (target.kind === "ask") {
    if (response.actionIdentifier === APPROVE_ACTION) {
      return h.approve(target.askId);
    }
    if (response.actionIdentifier === DENY_ACTION) {
      return h.deny(target.askId);
    }
  }
  // Body tap (the default identifier) — or a dismiss, which opens nothing.
  if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
    h.open(target);
  }
};

export function initNotifications(h: NotifyHandlers): () => void {
  /* Backgrounded-only banners, like the real app: while the app is open the
     Needs you stack and the CEO pulse already show the same news, so an
     iOS banner on top would say it twice. */
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: false,
      shouldShowList: false,
    }),
  });
  void categoryReady.catch(() => {});

  const sub = Notifications.addNotificationResponseReceivedListener((r) =>
    route(r, h),
  );
  // The response that launched the app from killed — the listener above
  // was not attached yet when iOS delivered it.
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) route(r, h);
    Notifications.clearLastNotificationResponse();
  });
  return () => sub.remove();
}

let permission: Promise<boolean> | undefined;

export function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    const now = await Notifications.getPermissionsAsync();
    if (now.status === "granted") return true;
    if (!now.canAskAgain) return false;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return asked.status === "granted";
  })();
  return permission;
}

const post = async (
  content: Notifications.NotificationContentInput,
): Promise<void> => {
  if (!(await ensurePermission())) return;
  await categoryReady;
  // `trigger: null` = deliver now; the handler above hides it in the foreground.
  await Notifications.scheduleNotificationAsync({ content, trigger: null });
};

/** A new ask: title = what is asked, body = who asks + why. */
export function notifyAsk(a: {
  id: string;
  title: string;
  body: string;
}): Promise<void> {
  return post({
    title: a.title,
    body: a.body,
    categoryIdentifier: ASK_CATEGORY,
    data: { askId: a.id },
  });
}

/** A new CEO update (no actions: the tap opens the CEO thread). */
export function notifyUpdate(u: {
  id: string;
  title: string;
  body: string;
}): Promise<void> {
  return post({ title: u.title, body: u.body, data: { updateId: u.id } });
}
