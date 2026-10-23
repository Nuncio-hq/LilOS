import { useEffect } from "react";
import { AppState } from "react-native";
import { CEO_THREAD_ID } from "./model";
import { openTab, openThread, whenNavReady } from "./nav";
import {
  ensurePermission,
  initNotifications,
  type NotifyTarget,
  notifyAsk,
  notifyUpdate,
} from "./notify";
import { approve, deny, focusAsk, releaseNext } from "./store";

/* How long after the app goes to the background the demo company "gets news".
   Long enough to lock the phone, short enough to wait for. iOS owns the
   delay (a time-interval trigger): a JS timer does not run once the phone
   locks and the app is suspended, so it would fire on resume, when the
   foreground handler hides the banner. */
const NEWS_AFTER_S = 4;

function open(target: NotifyTarget) {
  whenNavReady(() => {
    if (target.kind === "ask") {
      focusAsk(target.askId);
      openTab("Needs");
    } else {
      openThread(CEO_THREAD_ID);
    }
  });
}

/** Release the next queued ask or CEO update into the company and post it as
    a local notification `afterSeconds` later (0 = now); the item is already
    in the company, so the notification's Approve decides a real ask. */
export function pushNext(kind?: "ask" | "update", afterSeconds = 0) {
  const next = releaseNext(kind);
  if (!next) return;
  void (next.kind === "ask"
    ? notifyAsk(next, afterSeconds)
    : notifyUpdate(next, afterSeconds));
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
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") pushNext(undefined, NEWS_AFTER_S);
    });
    return () => {
      stop();
      sub.remove();
    };
  }, []);
}
