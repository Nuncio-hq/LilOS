import { ShortcutsDialog, ToastView, type V3Nav, V3Shell } from "@lilos/ui";
import { useCallback, useMemo, useState } from "react";
import { BrowserDock, BrowserWindowApp } from "../lib/browser";
import { useAtom } from "../lib/hooks";
import { bootError, booted, engine, relay } from "../lib/runtime";
import { toast } from "../lib/toast";
import { ThreadPanel } from "../thread/thread-panel";
import { makeV3Actions } from "./actions";
import { AddFolderHost } from "./add-folder";
import { StatusBanner, StatusDetails } from "./banner";
import { v3DataStore } from "./data";
import { useShellEffects } from "./effects";
import { moveNav, v3Nav } from "./nav";
import { visibleNav } from "./shown";

/* The real app's root (D-#769: one shell — the page on the left, one record
   in a side peek with its trail, a widened thread is the session view, where
   you are is the URL hash, a control exists only when the engine can do it).
   V3Shell runs on the relay's company: the nav is nav.ts, the data one
   computed store (data.ts), every click an action (actions.ts). The thread
   in the peek and widened is ThreadPanel: the one v3 thread view, running on
   engine events (#770). Not: a second UI, a route per record, placeholder or
   duplicate controls. */

function Company() {
  const nav = useAtom(v3Nav);
  const data = useAtom(v3DataStore());
  /* What the shell draws, not what the hash says (a gated page is Home, a
     gated record is not opened): every move starts from it, or a click on
     the gated page (drawn as Home) would write `page=work` back into the
     URL. */
  const { tickets } = data.features;
  const hasUpdates = data.updates.length > 0;
  const shown = visibleNav(nav, tickets, hasUpdates);
  const move = useCallback(
    (update: (n: V3Nav) => V3Nav) =>
      moveNav((raw) => update(visibleNav(raw, tickets, hasUpdates))),
    [tickets, hasUpdates],
  );
  const description = useAtom(engine.description);
  // #115/D-#19: Hire exists only while the engine can create agents; the new
  // chat's `/` menu only while it lists commands.
  const has = (id: string) =>
    description?.capabilities.some((c) => c.id === id) ?? false;
  const agents = has("agents");
  const commands = has("commands");
  const actions = useMemo(
    () => makeV3Actions({ agents, commands }),
    [agents, commands],
  );
  const toastMsg = useAtom(toast);
  const [search, setSearch] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const openSearch = useCallback(() => setSearch((n) => n + 1), []);
  const toggleShortcuts = useCallback(() => setShortcuts((o) => !o), []);
  const [sidebar, setSidebar] = useState(0);
  const toggleSidebar = useCallback(() => setSidebar((n) => n + 1), []);
  useShellEffects({
    move,
    openSearch,
    openShortcuts: toggleShortcuts,
    toggleSidebar,
  });
  return (
    <div className="flex h-dvh">
      <div className="min-w-0 flex-1">
        <V3Shell
          data={data}
          actions={actions}
          nav={shown}
          onNav={move}
          banner={<StatusBanner />}
          searchRequest={search}
          sidebarRequest={sidebar}
          // The window's vibrancy follows the theme or the sidebar turns
          // unreadable (#232).
          onThemeChange={(theme) => window.lilos?.setThemeSource?.(theme)}
          renderThread={({ id, go, scrollTo, onScrolled }) => (
            <ThreadPanel
              conversationId={id}
              scrollTo={scrollTo}
              onScrolled={onScrolled}
              onOpenAgent={(employeeId) =>
                go({ page: "agent", id: employeeId })
              }
              onOpenThread={(threadId) => go({ page: "thread", id: threadId })}
              // A widened thread is the session view (chat beside the
              // Workbench): one flag, in the URL, for both.
              session={shown.full === true}
              onSession={(open) => move((n) => ({ ...n, full: open }))}
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
      {/* The new chat's "New project from a folder…" opens this. */}
      <AddFolderHost />
      {/* The banner's Details and first run's "See status" open this one. */}
      <StatusDetails />
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
