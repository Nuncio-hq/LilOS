import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { foreignOverlayOpen } from "../chat/ui-layers";
import { ConversationReflowKey } from "../components/ai-elements/conversation";
import { draftKey, setDraft } from "../lib/drafts";
import { useTheme } from "../shell/use-theme";
import type { Theme } from "../types";
import type { V3Data, V3Draft } from "./v3-data-types";
import { EscLayer } from "./v3-keys";
import { SIDEBAR_W, shellSizes, useLayoutPrefs } from "./v3-layout-prefs";
import { defaultAgent } from "./v3-model";
import { step } from "./v3-nav";
import { OpenRecord } from "./v3-open-record";
import type {
  V3Actions,
  V3DataActions,
  V3Nav,
  V3PageProps,
  V3Route,
} from "./v3-page-types";
import { PAGE_NAME, V3PageView } from "./v3-page-view";
import { V3Palette } from "./v3-palette";
import { V3Peek } from "./v3-peek";
import { SidebarHotZone, useSidebarPopout } from "./v3-popout";
import { ResizeHandle, useWidth } from "./v3-resize";
import { V3Sidebar } from "./v3-sidebar";
import { type SidebarMode, SidebarShortcuts, V3TopBar } from "./v3-topbar";
import { V3Welcome } from "./v3-welcome";

export type V3ShellProps = {
  /** The company as it is now; the app owns it (mock engine or relay). */
  data: V3Data;
  /** Every change goes through these; the shell adds only ⌘K. */
  actions: V3DataActions;
  /** Where you are; the app owns it so the URL and Back/Forward work. Updates
     come as functions so two moves in one click (go to Threads, then open
     the new chat) both land. */
  nav: V3Nav;
  onNav: (update: (nav: V3Nav) => V3Nav) => void;
  /** The CEO behind ⌘K: a reply or a draft plan for one line. Without it,
     ⌘K only searches and jumps. */
  draft?: (text: string, data: V3Data) => V3Draft;
  /** The app's thread view for a thread record (the prototype passes the same
     component on mock data). `scrollTo` is a message to bring into view (a
     ⌘K message hit opened the thread); the view calls `onScrolled` once it
     has, which clears it. */
  renderThread: (
    props: V3PageProps & {
      id: string;
      scrollTo?: string;
      onScrolled?: () => void;
    },
  ) => ReactNode;
  /** A notice above the page (connection lost, engine down); the app decides
     when there is one. */
  banner?: ReactNode;
  /** The app bumps this to open ⌘K when a native menu consumed the chord. */
  searchRequest?: number;
  /** The same for ⌘\: the desktop View menu consumed it, so the app asks
     the shell to hide or show the sidebar through this counter. */
  sidebarRequest?: number;
  /** The theme the shell shows changed; the app tells its window. */
  onThemeChange?: (theme: Theme) => void;
};

/* The v3 shell: pages read `data` and change it only through `actions`, so
   every screen stays consistent after a click (approve on Home and Needs
   you, Threads and Work all agree). It owns movement: a page on the left,
   what you opened from it in the side peek on the right (see v3-nav.ts). */
export function V3Shell({
  data,
  actions,
  nav,
  onNav,
  draft,
  renderThread,
  banner,
  searchRequest,
  sidebarRequest,
  onThemeChange,
}: V3ShellProps) {
  const [palette, setPalette] = useState<string | null>(null);
  /* A ⌘K message hit: the thread to open and the message to show in it. Held
     here, not in the URL: a reload or a shared link opens the thread at its
     end, and the jump happens once. */
  const [jump, setJump] = useState<{ threadId: string; messageId: string }>();
  const clearJump = useCallback(() => setJump(undefined), []);
  // A jump that never landed (the thread has no such message) must not wait
  // around for the next time that thread opens.
  const openId = nav.peek[nav.peek.length - 1];
  useEffect(() => {
    if (jump && !(openId?.page === "thread" && openId.id === jump.threadId))
      setJump(undefined);
  }, [jump, openId]);
  const [theme, setTheme] = useTheme();
  useEffect(() => onThemeChange?.(theme), [theme, onThemeChange]);
  /* A native menu can consume ⌘K before the page sees it; the app then asks
     for the palette through this counter instead of a faked key press. */
  const lastSearch = useRef(searchRequest);
  useEffect(() => {
    if (searchRequest === lastSearch.current) return;
    lastSearch.current = searchRequest;
    setPalette((p) => (p === null ? "" : null));
  }, [searchRequest]);
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  /* Two ways to move, one rule each: the page opens a record fresh; the peek
     extends its trail. Changing page always starts at the page's top. */
  const goFromPage = useCallback(
    (r: V3Route) => {
      onNav((n) => step(n, r, "page"));
      if (!("id" in r))
        document.getElementById("v3-main")?.scrollTo({ top: 0 });
    },
    [onNav],
  );
  const goFromPeek = useCallback(
    (r: V3Route) => onNav((n) => step(n, r, "peek")),
    [onNav],
  );
  const closePeek = useCallback(
    () => onNav((n) => ({ ...n, peek: [], full: false })),
    [onNav],
  );
  /* The layout is this device's: column widths and whether the sidebar is
     hidden persist (v3-layout-prefs.ts). Limits come from the window, so
     shrinking it never crushes the page: the peek gives way first, then the
     sidebar. */
  const prefs = useLayoutPrefs();
  const { hidden, setHidden } = prefs;
  const [frame, frameW] = useWidth();
  const { side, peek } = shellSizes(frameW, prefs);
  const pop = useSidebarPopout(hidden);
  const mode: SidebarMode = !hidden
    ? "docked"
    : pop.popped
      ? "popped"
      : "hidden";
  const toggleSidebar = useCallback(
    () => setHidden(!hidden),
    [hidden, setHidden],
  );
  // The desktop View menu's ⌘\ arrives as a request, like ⌘K's.
  const lastSidebar = useRef(sidebarRequest);
  useEffect(() => {
    if (sidebarRequest === lastSidebar.current) return;
    lastSidebar.current = sidebarRequest;
    toggleSidebar();
  }, [sidebarRequest, toggleSidebar]);

  const { popped, tuck } = pop;
  /* Esc over a floating sidebar tucks it. It is a layer, not a bubble-phase
     branch: a widened thread under it is a layer too and takes Esc in the
     capture phase first — narrowing the page while the sidebar stayed open.
     Keyboard focus inside the sidebar would be lost with it: hand it to the
     toolbar's toggle, where the sidebar's controls were one tab away. */
  const tuckOnEsc = useCallback(() => {
    const inside = document.activeElement?.closest("aside");
    tuck();
    if (inside && inside === pop.side.current)
      document
        .querySelector<HTMLElement>("[data-sidebar-shortcuts] button")
        ?.focus();
  }, [tuck, pop.side]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A panel that already used the key (its own Esc) keeps it to itself.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p === null ? "" : null));
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === "\\" || e.code === "Backslash")
      ) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      /* Esc closes the peek unless you are typing, the palette owns Esc, or
         a menu/popover/dialog of the thread is open: that overlay closes on
         this very key and must not take the peek with it (the layer stack
         leaves such a key unhandled for the overlay, so it reaches us). */
      const typing = (e.target as HTMLElement | null)?.closest(
        "input, textarea",
      );
      if (
        e.key !== "Escape" ||
        palette !== null ||
        typing ||
        foreignOverlayOpen()
      )
        return;
      closePeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, closePeek, toggleSidebar]);

  /* The prototype passes `draft`: ⌘K is the CEO. The real app does not,
     so asking opens a new chat with the CEO (or the default agent until
     one is named, #778) and the words are already in the box. No agents:
     the new-chat page's empty state, never Search. From inside the peek
     the draft extends the trail; from the page it starts one. */
  const openAsk = useCallback(
    (text: string | undefined, from: "page" | "peek") => {
      if (draft) {
        setPalette(text ?? "");
        return;
      }
      const ceo =
        data.agents.find((a) => a.id === data.ceoId) ?? defaultAgent(data);
      const go = from === "peek" ? goFromPeek : goFromPage;
      if (!ceo) {
        go({ page: "newchat", id: "none" });
        return;
      }
      if (text) setDraft(draftKey.dm(ceo.id), text);
      go({ page: "newchat", id: ceo.id });
    },
    [data, draft, goFromPage, goFromPeek],
  );
  const act = useMemo<V3Actions>(
    () => ({ ...actions, ask: (text) => openAsk(text, "page") }),
    [actions, openAsk],
  );
  const peekAct = useMemo<V3Actions>(
    () => ({ ...act, ask: (text) => openAsk(text, "peek") }),
    [act, openAsk],
  );

  const startPlan = (
    plan: Extract<V3Draft, { kind: "plan" }>,
    text: string,
  ) => {
    if (!actions.startPlan) return;
    actions.startPlan(plan, text);
    goFromPage({ page: "work", view: "waiting" });
  };

  const page = nav.page;
  const top = nav.peek[nav.peek.length - 1];
  const props = { data, go: goFromPage, act };
  const widened = !!top && !!nav.full;
  const beside = !!top && !nav.full;
  /* A hidden sidebar leaves its toggle and Search in the toolbar, leading the
     leftmost segment: the page's, or the peek's once it covers the page. */
  const shortcuts = hidden ? (
    <SidebarShortcuts onShow={toggleSidebar} onSearch={() => setPalette("")} />
  ) : undefined;
  /* First run owns the whole window: nothing to navigate yet. The Mac app has
     no title bar (D-#232), so this strip is what the window is moved by and
     where the traffic lights sit. It has no height of its own: the app's
     desktop stylesheet gives it the toolbar row's height, so a browser tab
     loses nothing. The page scrolls beneath it, never under it, so no control
     is ever swallowed by the drag region. */
  if (page.page === "welcome" || !data.setUp)
    return (
      <div className="lilos-v3 flex h-dvh flex-col bg-[var(--v3-main)] text-[14px] text-foreground">
        <div aria-hidden className="lilos-drag shrink-0" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <V3Welcome {...props} />
        </div>
      </div>
    );
  return (
    <OpenRecord.Provider value={top}>
      <div
        ref={frame}
        className="lilos-v3 relative flex h-dvh min-h-0 overflow-hidden bg-[var(--v3-main)] text-[14px] text-foreground"
      >
        {popped && palette === null && <EscLayer onEscape={tuckOnEsc} />}
        <V3Sidebar
          data={data}
          page={page}
          open={top}
          go={goFromPage}
          onSearch={() => setPalette("")}
          dark={dark}
          onTheme={() => setTheme(dark ? "light" : "dark")}
          canHire={!!actions.hire}
          mode={mode}
          width={side.w}
          sideRef={pop.side}
          onToggle={toggleSidebar}
          onPointerEnter={pop.cancel}
          onPointerLeave={pop.tuckSoon}
          onBlur={pop.tuckSoon}
        />
        {!hidden && (
          <ResizeHandle
            label="Resize sidebar"
            className="mt-[var(--v3-toolbar-h)]"
            value={side.w}
            min={SIDEBAR_W.min}
            max={side.max}
            grows="right"
            edge="before"
            onChange={prefs.setSidebarW}
            onReset={() => prefs.setSidebarW(undefined)}
          />
        )}
        {/* Everything right of the sidebar is one grid on three rows: the
          toolbar row, a notice (drawn only while something is wrong), the
          page. The page and the side peek sit side by side in it; the peek
          spans all three rows, so its own toolbar items stand in the toolbar
          row above it and a notice stays above the page and the peek alike.
          Widened, the peek covers the page (still mounted, scroll and all)
          and the toolbar row over it, so closing it puts you exactly where
          you were. */}
        <div
          className="grid min-h-0 min-w-0 flex-1 grid-rows-[var(--v3-toolbar-h)_auto_minmax(0,1fr)]"
          style={{
            gridTemplateColumns: beside
              ? `minmax(0,1fr) ${peek.w}px`
              : "minmax(0,1fr)",
          }}
        >
          <V3TopBar lead={widened ? undefined : shortcuts} />
          <div className="relative z-30 col-span-full row-start-2">
            {banner}
          </div>
          <main
            id="v3-main"
            data-v3-scroller
            key={JSON.stringify(page)}
            className="lilos-v3-line-in @container col-start-1 row-start-3 min-h-0 min-w-0 overflow-y-auto"
          >
            <V3PageView page={page} {...props} />
          </main>
          {beside && (
            <ResizeHandle
              label="Resize side panel"
              className="col-start-2 row-span-2 row-start-2"
              value={peek.w}
              min={peek.min}
              max={peek.max}
              grows="left"
              edge="after"
              onChange={prefs.setPeekW}
              onReset={() => prefs.setPeekW(undefined)}
            />
          )}
          {top && (
            <V3Peek
              data={data}
              lead={widened ? shortcuts : undefined}
              renderThread={(p) => (
                /* #315: the panes' widths as one key — the thread re-pins
                   to its bottom in the very commit that moves them (see
                   the guard in conversation.tsx). */
                <ConversationReflowKey.Provider
                  value={`${hidden ? 0 : side.w}:${peek.w}:${nav.full ? "full" : "side"}`}
                >
                  {renderThread({
                    ...p,
                    ...(jump?.threadId === p.id
                      ? { scrollTo: jump.messageId, onScrolled: clearJump }
                      : {}),
                  })}
                </ConversationReflowKey.Provider>
              )}
              go={goFromPeek}
              act={peekAct}
              trail={nav.peek}
              full={!!nav.full}
              pageName={PAGE_NAME[page.page]}
              onBack={() =>
                onNav((n) => ({
                  ...n,
                  peek: n.peek.slice(0, -1),
                  full: n.peek.length > 1 && n.full,
                }))
              }
              onTrail={(i) =>
                onNav((n) => ({ ...n, peek: n.peek.slice(0, i + 1) }))
              }
              onFull={(full) => onNav((n) => ({ ...n, full }))}
              onClose={closePeek}
            />
          )}
        </div>
        {/* After the toolbar's drag regions: the OS applies them in document
          order, so this strip must come last to stay the pointer's. */}
        {hidden && <SidebarHotZone onEnter={pop.show} onLeave={pop.tuckSoon} />}
        {palette !== null && (
          <V3Palette
            data={data}
            seed={palette}
            draft={draft}
            onStart={startPlan}
            onClose={() => setPalette(null)}
            go={goFromPage}
            searchMessages={actions.searchMessages}
            onOpenMessage={(threadId, messageId) => {
              setJump({ threadId, messageId });
              goFromPage({ page: "thread", id: threadId });
            }}
          />
        )}
      </div>
    </OpenRecord.Provider>
  );
}
