import { useEffect } from "react";
import { AppState } from "react-native";
import { CEO_THREAD_ID } from "./model";
import { openTab, openThread, v3Nav } from "./nav";
import {
  ensurePermission,
  initNotifications,
  type NotifyTarget,
  notifyAsk,
  notifyUpdate,
} from "./notify";
import { approve, deny, focusAsk, releaseNext } from "./store";

/* How long after the app goes to the background the demo company "gets news".
   Long enough to lock the phone, short enough to wait for. */
const NEWS_AFTER_MS = 4000;

/** Run once the navigation tree exists: a notification that launched the app
    from killed arrives before the first screen is mounted. */
function whenReady(fn: () => void, tries = 40) {
  if (v3Nav.isReady()) fn();
  else if (tries > 0) setTimeout(() => whenReady(fn, tries - 1), 150);
}

function open(target: NotifyTarget) {
  whenReady(() => {
    if (target.kind === "ask") {
      focusAsk(target.askId);
      openTab("Needs");
    } else {
      openThread(CEO_THREAD_ID);
    }
  });
}

/** Post the next queued ask or CEO update as a local notification; the item
    is already in the company, so the notification's Approve decides a real
    ask. Exported for the `lilos://preview?push=` deep link. */
export function pushNext(kind?: "ask" | "update") {
  const next = releaseNext(kind);
  if (!next) return;
  void (next.kind === "ask" ? notifyAsk(next) : notifyUpdate(next));
}

/** Notifications for the v3 app: lock-screen Approve/Deny and taps route
    into the store; backgrounding the app triggers the demo news. */
export function useNotifications() {
  useEffect(() => {
    void ensurePermission();
    const stop = initNotifications({
      approve: (id) => approve(id),
      deny: (id) => deny(id),
      open,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener("change", (state) => {
      clearTimeout(timer);
      if (state === "background") {
        timer = setTimeout(() => pushNext(), NEWS_AFTER_MS);
      }
    });
    return () => {
      stop();
      sub.remove();
      clearTimeout(timer);
    };
  }, []);
}
