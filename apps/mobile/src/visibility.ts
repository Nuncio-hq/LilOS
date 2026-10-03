import { AppState, type AppStateStatus } from "react-native";
import { $demo } from "./demo/lifecycle";
import { $client, $link } from "./link";
import { nav, type Routes } from "./routes";

/**
 * Foreground-thread reporting (#161 AC-5): the relay suppresses a push for
 * the thread this phone is looking at, and the suppression source is the
 * phone itself — the app reports the visible conversation over
 * `push.visibility` whenever the navigator state or AppState flips.
 *
 * Route-level, not screen-level: the top route's `conversationId` is the
 * report, so `thread.tsx` never had to opt in (the fleet note). Thread and
 * the thread-scoped sheets — ThreadInfo/Plan/Subagent/Background, plus a
 * ModelPicker opened for the thread — count as "in the thread"; Dm, the
 * Mac list and a ModelPicker without a conversationId mean the user has
 * left the thread's context. A backgrounded phone reports `null`, and a
 * dead socket clears the report relay-side, so a stale "open" can't mute
 * pushes after the app is gone.
 *
 * If a future screen needs finer control it can call `reportVisibleThread`
 * directly — e.g. thread.tsx could report only once the thread's content
 * is actually on screen.
 */

/* Sheets that still read as "in the thread" — they sit over its content. */
const THREAD_ROUTES = new Set<keyof Routes>([
  "Thread",
  "ThreadInfo",
  "Plan",
  "Subagent",
  "Background",
  /* Thread-scoped when opened with a conversationId — the param check in
     visibleConversationId yields null for the DM-scoped form. */
  "ModelPicker",
]);

/** The conversation on screen right now, or null. */
function visibleConversationId(): string | null {
  if (!nav.isReady() || AppState.currentState !== "active") return null;
  const routes = nav.getRootState()?.routes;
  const top = routes?.[routes.length - 1];
  if (!top) return null;
  if (!THREAD_ROUTES.has(top.name as keyof Routes)) return null;
  const params = top.params as { conversationId?: string } | undefined;
  return typeof params?.conversationId === "string"
    ? params.conversationId
    : null;
}

let reported: string | null = null;
let reportedSent = false;

const report = (conversationId: string | null) => {
  if (conversationId === reported && reportedSent) return;
  reported = conversationId;
  const client = $client.get();
  /* The demo shows an online link but has no pushes to suppress — skip. */
  if (!client || $link.get() !== "online" || $demo.get()) {
    /* Not connected: remember the intent so coming online re-reports. */
    reportedSent = false;
    return;
  }
  reportedSent = true;
  client.request("push.visibility", { conversationId }).catch(() => {
    /* Lost between request and receipt — re-report on the next trigger. */
    reportedSent = false;
  });
};

let started = false;
/** Idempotent wiring: nav state + AppState + reconnect each re-report. */
export function startVisibilityReporting(): void {
  if (started) return;
  started = true;
  const recompute = () => report(visibleConversationId());
  nav.addListener("state", recompute);
  AppState.addEventListener("change", (_next: AppStateStatus) => {
    recompute();
  });
  /* A reconnect is a fresh socket — the relay forgot this device's report,
     so re-send whatever is currently on screen. */
  $link.listen((state) => {
    if (state === "online") {
      reportedSent = false;
      recompute();
    }
  });
}
