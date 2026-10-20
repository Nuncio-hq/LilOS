import { ShortcutsDialog, type V3Nav, V3Shell } from "@lilos/ui";
import { useCallback, useMemo, useState } from "react";
import { BrowserDock, BrowserWindowApp } from "../lib/browser";
import { useAtom } from "../lib/hooks";
import { bootError, booted, engine, relay } from "../lib/runtime";
import { toast } from "../lib/toast";
import { ToastView } from "../lib/toast-view";
import { ThreadPanel } from "../thread/thread-panel";
import { makeV3Actions } from "./actions";
import { StatusBanner } from "./banner";
import { v3DataStore } from "./data";
import { useShellEffects } from "./effects";
import { moveNav, v3Nav } from "./nav";

/* The real app's root: V3Shell on the relay's company. Where you are lives in
   the URL hash (nav.ts); the data is one computed store (data.ts); every click
   is an action (actions.ts). The thread beside a page is the app's own thread
   view until the v3 conversation runs on engine events (#770). */

/** Work, Goals and Inbox wait for tickets (M2): a link to one lands on Home
    and a ticket, goal or project record is not opened. */
function visibleNav(nav: V3Nav, tickets: boolean): V3Nav {
  if (tickets) return nav;
  const gated = ["work", "inbox", "goals"].includes(nav.page.page);
  const peek = nav.peek.filter(
    (r) => r.page !== "ticket" && r.page !== "goal" && r.page !== "project",
  );
  if (!gated && peek.length === nav.peek.length) return nav;
  return { ...nav, page: gated ? { page: "home" } : nav.page, peek };
}

function Company() {
  const nav = useAtom(v3Nav);
  const data = useAtom(v3DataStore());
  const description = useAtom(engine.description);
  // #115/D-#19: Hire exists only while the engine can create agents.
  const canHire =
    description?.capabilities.some((c) => c.id === "agents") ?? false;
  const actions = useMemo(() => makeV3Actions(canHire), [canHire]);
  const toastMsg = useAtom(toast);
  const [search, setSearch] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const openSearch = useCallback(() => setSearch((n) => n + 1), []);
  const toggleShortcuts = useCallback(() => setShortcuts((o) => !o), []);
  useShellEffects({ nav, openSearch, openShortcuts: toggleShortcuts });
  return (
    <div className="flex h-dvh">
      <div className="min-w-0 flex-1">
        <V3Shell
          data={data}
          actions={actions}
          nav={visibleNav(nav, data.features.tickets)}
          onNav={moveNav}
          banner={<StatusBanner />}
          searchRequest={search}
          // The window's vibrancy follows the theme or the sidebar turns
          // unreadable (#232).
          onThemeChange={(theme) => window.lilos?.setThemeSource?.(theme)}
          renderThread={({ id, go }) => (
            <ThreadPanel
              conversationId={id}
              onOpenAgent={(employeeId) =>
                go({ page: "agent", id: employeeId })
              }
              onOpenThread={(threadId) => go({ page: "thread", id: threadId })}
              // Its Focus is the session view: the peek widens over the page.
              onSession={(open) => moveNav((n) => ({ ...n, full: open }))}
            />
          )}
        />
      </div>
      <BrowserDock />
      {shortcuts && (
        <ShortcutsDialog
          desktop={window.lilos?.isDesktop === true}
          onClose={() => setShortcuts(false)}
        />
      )}
      {/* One-line notices (failed sends, the Undo of a rewind). */}
      {toastMsg && <ToastView toast={toastMsg} />}
    </div>
  );
}

function Boot() {
  const ready = useAtom(booted);
  const error = useAtom(bootError);
  if (error)
    return (
      <div className="grid h-dvh place-items-center bg-background p-6">
        <div className="max-w-md rounded-xl border border-[var(--v3-line)] p-5 text-sm">
          <div className="font-semibold text-foreground">
            LilOS could not start
          </div>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <p className="mt-2 text-muted-foreground text-xs">
            Run <code>bun run dev</code> in apps/web to boot relay + engine +
            this page together.
          </p>
        </div>
      </div>
    );
  if (!ready) return <Connecting />;
  return <Loaded />;
}

const Connecting = () => (
  <div className="grid h-dvh place-items-center bg-background text-muted-foreground text-sm">
    Connecting to the local relay…
  </div>
);

/* The shell draws the company, so it waits for the relay's first directory
   snapshot: a reload with a record open (`open=agent:…`) must find that
   agent. It only ever turns true, so a reconnect never blanks the app.
   `relay` exists only once boot is done, hence its own component. */
function Loaded() {
  const directory = useAtom(relay.directoryReady);
  return directory ? <Company /> : <Connecting />;
}

export function App() {
  /* The popped-out LilOS Browser window loads this same bundle behind a
     preload flag: browser chrome over a native page slot, not the app shell
     (no relay). */
  if (window.lilos?.browser?.isBrowserWindow) return <BrowserWindowApp />;
  return <Boot />;
}
