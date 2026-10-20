import type { DesktopShortcutAction } from "@lilos/contracts/app";
import { stepNav, type V3Nav } from "@lilos/ui";
import { useEffect } from "react";
import { useBrowserContextPush } from "../lib/browser";
import { refreshFolders } from "../lib/folders";
import { shortcutFromKey } from "../lib/keys";
import { watchNotifications } from "../lib/notify";
import { watchPresence } from "../lib/presence";
import {
  engine,
  openConversation,
  relay,
  sessionModels,
  sessionSignals,
} from "../lib/runtime";
import { isSettingsShortcut } from "../settings/state";
import { watchBrowserTabs } from "./browser";
import { moveNav, openThread, openThreadId, v3Nav } from "./nav";

/* Everything the old AppShell did besides drawing pages, for the v3 root:
   the engine feed for the open thread, the Mac's notifications, presence for
   the phone, the desktop browser's roster, and the keyboard map. */

/** The agent on screen (an open agent or new chat), else the first one. */
function currentAgentId(nav: V3Nav): string | undefined {
  const top = nav.peek[nav.peek.length - 1];
  if (top?.page === "agent" || top?.page === "newchat") return top.id;
  return relay.employees.get()[0]?.id;
}

export function useShellEffects({
  nav,
  openSearch,
  openShortcuts,
}: {
  nav: V3Nav;
  /** Ask the shell for ⌘K when a native menu consumed the chord. */
  openSearch: () => void;
  openShortcuts: () => void;
}): void {
  /* #572: the thread on screen earns an engine feed (the session watch's
     scope head) and the read watermark follows it; leaving releases it. */
  useEffect(() => openConversation.set(openThreadId(nav)), [nav]);

  /* LilOS Browser (desktop): relay roster → host, host tabs → v3. */
  useBrowserContextPush();
  useEffect(() => watchBrowserTabs(), []);
  // Recents for the new-chat folder chip.
  useEffect(() => void refreshFolders().catch(() => {}), []);

  /* Notifications (#32): engine events → macOS notifications when the
     conversation isn't in view; a click opens that thread. #561: while the
     human is at this Mac the relay silences the phone. */
  useEffect(() => {
    const bridge = window.lilos;
    if (!bridge) return;
    const unsubs: Array<() => void> = [];
    if (bridge.notifications) {
      unsubs.push(
        watchNotifications({
          onEvent: (fn) => engine.onEvent(fn),
          context: () => ({
            conversations: relay.conversations.get(),
            channels: relay.channels.get(),
            employees: relay.employees.get(),
          }),
          /* #572: asks read the broadcast-folded signals — seeded by relay
             asks, live request.* frames, and reconciled from synced models —
             so an unwatched session's approval still notifies. */
          isRequestOpen: (requestId) =>
            Object.values(sessionSignals.get()).some((s) =>
              s.openRequests.has(requestId),
            ),
          openAsks: () =>
            Object.entries(sessionSignals.get()).flatMap(([sessionId, s]) =>
              [...s.openRequests].map(([requestId, request]) => ({
                sessionId,
                requestId,
                request,
              })),
            ),
          onOpenAsksChange: (fn) => {
            /* Signals move on broadcast frames; models move on feed syncs — a
               replay can change the ask/completion set, so both re-run the
               state-driven check. */
            const unSignals = sessionSignals.subscribe(fn);
            const unModels = sessionModels.subscribe(fn);
            return () => {
              unSignals();
              unModels();
            };
          },
          /* #400/#572: done/failed the live frame dropped — re-evaluated from
             the feeds themselves on every model or view change. `feedState`
             is a non-creating read: only attached, synced feeds report. */
          completionEvents: () =>
            relay.conversations.get().flatMap((c) => {
              if (!c.engineRef) return [];
              const feed = engine.feedState(c.engineRef);
              if (!feed?.synced) return [];
              return [
                {
                  sessionId: c.engineRef,
                  events: feed.events.filter(
                    (e) =>
                      e.type === "turn.completed" ||
                      e.type === "turn.delta" ||
                      e.type === "turn.recap" ||
                      (e.type === "session.state" &&
                        e.payload.state === "error"),
                  ),
                },
              ];
            }),
          openConversationId: () => openThreadId(v3Nav.get()) ?? null,
          inForeground: () =>
            document.visibilityState === "visible" && document.hasFocus(),
          onViewChange: (fn) => {
            const un = v3Nav.listen(fn);
            document.addEventListener("visibilitychange", fn);
            window.addEventListener("focus", fn);
            window.addEventListener("blur", fn);
            return () => {
              un();
              document.removeEventListener("visibilitychange", fn);
              window.removeEventListener("focus", fn);
              window.removeEventListener("blur", fn);
            };
          },
          post: (n) => bridge.notifications?.post(n),
        }),
      );
    }
    if (bridge.presence) {
      unsubs.push(
        watchPresence({
          bridge: bridge.presence,
          report: (active) => relay.request("presence.report", { active }),
        }),
      );
    }
    // A notification click opens the thread beside Threads.
    if (bridge.onOpenConversation)
      unsubs.push(bridge.onOpenConversation(openThread));
    return () => {
      for (const u of unsubs) u();
    };
  }, []);

  /* Keyboard. ⌘K is the shell's own chord on the web; the desktop menu
     consumes it, so only there it arrives as a shortcut action. ⌘N and ⌘1–9
     are menu-only too. ⌘, opens Settings (menu item or chord). */
  useEffect(() => {
    const run = (action: DesktopShortcutAction): void => {
      const digit = /^employee-(\d)$/.exec(action);
      if (digit) {
        const id = relay.employees.get()[Number(digit[1]) - 1]?.id;
        if (id) moveNav((n) => stepNav(n, { page: "agent", id }, "page"));
        return;
      }
      if (action === "quick-switcher") openSearch();
      else if (action === "shortcuts") openShortcuts();
      else if (action === "back") history.back();
      else if (action === "forward") history.forward();
      else if (action === "new-session") {
        const id = currentAgentId(v3Nav.get());
        if (id) moveNav((n) => stepNav(n, { page: "newchat", id }, "page"));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (isSettingsShortcut(e)) {
        e.preventDefault();
        moveNav((n) => stepNav(n, { page: "settings" }, "page"));
        return;
      }
      const action = shortcutFromKey(e);
      // ⌘K is handled by the shell itself here.
      if (!action || action === "quick-switcher") return;
      if ((e.target as HTMLElement | null)?.closest?.("[data-lilos-terminal]"))
        return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener("keydown", onKey);
    const offShortcut = window.lilos?.onShortcut?.(run);
    const offSettings = window.lilos?.onOpenSettings?.(() =>
      moveNav((n) => stepNav(n, { page: "settings" }, "page")),
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      offShortcut?.();
      offSettings?.();
    };
  }, [openSearch, openShortcuts]);
}
