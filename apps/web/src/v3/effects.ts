import type { DesktopShortcutAction } from "@lilos/contracts/app";
import { isRecordRoute, stepNav, type V3Nav } from "@lilos/ui";
import { computed, type ReadableAtom } from "nanostores";
import { useEffect } from "react";
import { useBrowserContextPush } from "../lib/browser";
import { watchFolderAccess } from "../lib/folder-access";
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
import { v3DataStore } from "./data";
import { openThread, v3Nav } from "./nav";
import { threadOnScreen, visibleNav } from "./shown";
import { employeeOfConversation } from "./threads";

/* Everything the old AppShell did besides drawing pages, for the v3 root:
   the engine feed for the open thread, the Mac's notifications, presence for
   the phone, the desktop browser's roster, and the keyboard map. */

let onScreen: ReadableAtom<string | undefined> | undefined;

/** The thread the shell is drawing right now (see `threadOnScreen`): the nav
    on screen and whether first run owns the window. A store, so a move or the
    end of first run reaches the readers that the click did not touch. Built
    on first read: the data store needs the booted relay. */
function onScreenThread(): ReadableAtom<string | undefined> {
  onScreen ??= computed([v3Nav, v3DataStore()], threadOnScreen);
  return onScreen;
}

/** The agent ⌘N starts a chat with: the one on screen (an open agent, a new
    chat, or the agent behind the open thread), else the first one. */
function currentAgentId(): string | undefined {
  const company = v3DataStore().get();
  const nav = visibleNav(
    v3Nav.get(),
    company.features.tickets,
    company.updates.length > 0,
  );
  /* The frontmost record is the peek's top; with no peek the page can be
     the record itself (D-#769). */
  const top =
    nav.peek[nav.peek.length - 1] ??
    (isRecordRoute(nav.page) ? nav.page : undefined);
  if (top?.page === "agent" || top?.page === "newchat") return top.id;
  if (top?.page === "thread") {
    const conv = relay.conversations.get().find((c) => c.id === top.id);
    const agentId = conv && employeeOfConversation(conv, relay.channels.get());
    if (agentId) return agentId;
  }
  return relay.employees.get()[0]?.id;
}

export function useShellEffects({
  move,
  openSearch,
  openShortcuts,
  toggleSidebar,
}: {
  /** A move from the nav the shell draws (root.tsx), not the raw hash. */
  move: (update: (nav: V3Nav) => V3Nav) => void;
  /** Ask the shell for ⌘K when a native menu consumed the chord. */
  openSearch: () => void;
  openShortcuts: () => void;
  /** Ask the shell to hide or show its sidebar: ⌘\ arrives only as a menu
     action on desktop (the shell binds the chord itself on the web). */
  toggleSidebar: () => void;
}): void {
  /* #572: the thread on screen earns an engine feed (the session watch's
     scope head) and the read watermark follows it; leaving releases it. */
  useEffect(() => {
    const off = onScreenThread().subscribe((id) => openConversation.set(id));
    return () => {
      off();
      openConversation.set(undefined);
    };
  }, []);
  /* LilOS Browser (desktop): relay roster → host. The thread's Browser tab reads the host itself. */
  useBrowserContextPush();
  // Recents for the new-chat folder chip.
  useEffect(() => void refreshFolders().catch(() => {}), []);
  /* D-#875: the desktop's folder-access state — the ask step and the
     blocked banner read it. No bridge (plain web) → nothing happens. */
  useEffect(() => watchFolderAccess(), []);

  /* Notifications (#32): engine events → macOS notifications when the
     conversation isn't in view; a click opens that thread. #561: while the
     human is at this Mac the relay silences the phone. #819: a finish
     updates the watched feed (the re-check below) and is then delivered
     on `onEvent`. Both reach this one watcher, which posts once per
     thread + turn, and once per ask id. A finish on the standing CEO
     thread is not a banner (D-#777). */
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
               state-driven check. The live frame runs after that check;
               the watcher dedupes the pair (#819). */
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
          openConversationId: () => onScreenThread().get() ?? null,
          inForeground: () =>
            document.visibilityState === "visible" && document.hasFocus(),
          onViewChange: (fn) => {
            const un = onScreenThread().listen(fn);
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
        /* Keyboard jumps are `nav` moves (D-#769): they go to the record,
           full width — the same rule the sidebar and ⌘K follow. */
        if (id)
          move((n) =>
            stepNav(n, { page: "agent", id }, "nav", v3DataStore().get()),
          );
        return;
      }
      if (action === "quick-switcher") openSearch();
      else if (action === "shortcuts") openShortcuts();
      else if (action === "toggle-sidebar") toggleSidebar();
      else if (action === "back") history.back();
      else if (action === "forward") history.forward();
      else if (action === "new-session") {
        const id = currentAgentId();
        if (id)
          move((n) =>
            stepNav(n, { page: "newchat", id }, "nav", v3DataStore().get()),
          );
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (isSettingsShortcut(e)) {
        e.preventDefault();
        move((n) =>
          stepNav(n, { page: "settings" }, "nav", v3DataStore().get()),
        );
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
      move((n) => stepNav(n, { page: "settings" }, "nav", v3DataStore().get())),
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      offShortcut?.();
      offSettings?.();
    };
  }, [move, openSearch, openShortcuts, toggleSidebar]);
}
