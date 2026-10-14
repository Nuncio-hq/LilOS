import type {
  DesktopBrowserCommand,
  DesktopBrowserKey,
  DesktopBrowserMode,
  DesktopBrowserState,
  DesktopBrowserTabGroup,
} from "@lilos/contracts/app";
import {
  BrowserPanel,
  type BrowserThread,
  type BrowserTab as UiBrowserTab,
} from "@lilos/ui";
import type { EmpFn } from "@lilos/ui/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchDesktopChrome } from "./desktop";
import { useAtom } from "./hooks";
import { relay } from "./runtime";

/**
 * LilOS Browser, renderer side. The desktop main process owns the real
 * pages (a WebContentsView per tab on `persist:lilos-browser`) and pushes a
 * full state snapshot; this module is the chrome — it maps the snapshot to
 * BrowserPanel props, reports where each page slot sits so the host can lay
 * the native view on top, and runs no browser UI when the bridge is absent
 * (plain web, tests): `window.lilos.browser` is the D-#19 gate.
 *
 * Slot ids come from contracts/app/browser.ts: `panel` (the ⌘⇧B dock),
 * `window` (the popped-out OS window) and `thread:<conversationId>` (a
 * thread's Workbench Browser tab).
 */

const bridge = () => window.lilos?.browser;

/** Latest pushed browser snapshot (undefined until the first one lands). */
export function useBrowserState(): DesktopBrowserState | undefined {
  const [state, setState] = useState<DesktopBrowserState>();
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.command({ op: "getState" }).then((s) => s && setState(s));
    return b.onState(setState);
  }, []);
  return state;
}

/* Thread chips + employee lookup for the strip. The app window owns the
   relay and pushes this roster over `setContext`, so the relay-less pop-out
   window renders the same labels — every surface reads the pushed state. */
export function useBrowserContext(state: DesktopBrowserState | undefined): {
  threads: BrowserThread[];
  emp: EmpFn;
} {
  const threads = useMemo<BrowserThread[]>(
    () =>
      (state?.threads ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        employeeId: t.employeeId,
      })),
    [state?.threads],
  );
  const emp = useCallback<EmpFn>(
    (id) => {
      const e = state?.employees.find((x) => x.id === id);
      return e
        ? {
            id: e.id,
            name: e.name,
            status: (e.status as "online" | "busy" | "offline") ?? "offline",
            role: "",
            profile: "",
            model: "",
            now: "",
            instructions: "",
            respondTo: "me" as const,
          }
        : undefined;
    },
    [state?.employees],
  );
  return { threads, emp };
}

/** The app window keeps the host's thread/employee roster in sync with the
 *  relay snapshot; call once per render of the shell (cheap, deduped). */
export function useBrowserContextPush(): void {
  const conversations = useAtom(relay.conversations);
  const channels = useAtom(relay.channels);
  const employees = useAtom(relay.employees);
  useEffect(() => {
    const b = bridge();
    if (!b || b.isBrowserWindow) return;
    void b.command({
      op: "setContext",
      threads: conversations
        .map((c) => ({
          id: c.id,
          title: c.title,
          employeeId:
            channels.find((ch) => ch.id === c.channelId)?.employeeId ?? "",
        }))
        .filter((t) => t.employeeId !== ""),
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
      })),
    });
  }, [conversations, channels, employees]);
}

/** The omnibox's text → a URL the page view can load. */
export function toBrowserUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^(localhost|127\.|::1|\d+\.\d+\.\d+\.\d+)(:\d+)?([/?#].*)?$/.test(s))
    return `http://${s}`;
  if (/^[^\s/]+\.[^\s]{2,}([/?#].*)?$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

/* The FindBar floats ~48px over the page's top; while it's open the native
   view's slot shrinks by that much so the bar stays visible (a
   WebContentsView always paints above the page's DOM). */
const FIND_INSET = 48;

/* Chords the panel's own onKeyDown already handles — intercepted in the
   page by the host and re-dispatched here as real keydowns so both paths
   run the same code. Chords the panel doesn't bind run as commands. */
const KEY_CHORDS: Partial<Record<DesktopBrowserKey, string>> = {
  find: "f",
  focusUrl: "l",
  newTab: "t",
  closeTab: "w",
  zoomIn: "=",
  zoomOut: "-",
  zoomReset: "0",
  print: "p",
  back: "[",
  forward: "]",
};

/**
 * The page area: reports its bounds to the host so the native page view
 * lands exactly here, hides it while `covered` (the library sheet owns the
 * area then), and draws the "showing elsewhere" affordance when the active
 * tab's view is attached to a different slot.
 */
function PageSlot({
  slotId,
  covered,
  insetTop,
  elsewhere,
  onBringHere,
}: {
  slotId: string;
  covered: boolean;
  insetTop: number;
  elsewhere: boolean;
  onBringHere: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const coveredRef = useRef(covered);
  const insetRef = useRef(insetTop);
  coveredRef.current = covered;
  insetRef.current = insetTop;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const report = () => {
      const r = el.getBoundingClientRect();
      const rect = coveredRef.current
        ? null
        : {
            x: r.x,
            y: r.y + insetRef.current,
            width: r.width,
            height: Math.max(0, r.height - insetRef.current),
          };
      const key = rect
        ? `${rect.x},${rect.y},${rect.width},${rect.height}`
        : "hidden";
      if (key === last) return;
      last = key;
      bridge()?.reportSlot({ slotId, rect });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    /* Positions shift without this box resizing (sidebar collapse, sibling
       panels, scroll) — re-measure on a light poll; unchanged rects send
       nothing. */
    const poll = setInterval(report, 250);
    return () => {
      ro.disconnect();
      clearInterval(poll);
      bridge()?.reportSlot({ slotId, rect: null });
    };
  }, [slotId]);
  return (
    <div ref={ref} className="relative h-full w-full">
      {elsewhere && (
        <div className="absolute inset-0 grid place-items-center bg-background text-muted-foreground text-[13px]">
          <div className="text-center">
            <p>This tab is showing in another LilOS Browser surface.</p>
            <button
              type="button"
              className="mt-2 rounded-md border px-3 py-1.5 text-foreground hover:bg-muted"
              onClick={onBringHere}
            >
              Show it here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One browser surface bound to a slot: full chrome (strip + omnibox + find
 * + library) over a native page slot. `mode` follows the panel's modes;
 * `group` makes new tabs belong to a thread (Workbenches).
 */
export function BrowserSlotView({
  slotId,
  mode,
  group,
  osWindow,
  className,
}: {
  slotId: string;
  mode: DesktopBrowserMode | "thread";
  group?: DesktopBrowserTabGroup;
  osWindow?: boolean;
  className?: string;
}) {
  const state = useBrowserState();
  const { threads, emp } = useBrowserContext(state);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState({ query: "", index: 0 });
  const [covered, setCovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const cmd = useCallback((c: DesktopBrowserCommand) => {
    void bridge()?.command(c);
  }, []);

  useEffect(
    () =>
      bridge()?.onKey((key, slot) => {
        if (slot !== slotId) return;
        const chord = KEY_CHORDS[key];
        if (chord) {
          rootRef.current?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: chord,
              metaKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        } else if (key === "reload") {
          cmd({ op: "reload", slotId });
        } else if (key === "devTools") {
          cmd({ op: "devTools", slotId });
        }
      }),
    [slotId, cmd],
  );

  const allTabs = state?.tabs ?? [];
  const tabs = useMemo(
    () =>
      (mode === "thread" && group
        ? allTabs.filter((t) => t.group?.threadId === group.threadId)
        : allTabs
      ).map(
        (t): UiBrowserTab => ({
          id: t.id,
          title: t.title,
          url: t.url,
          loading: t.loading,
          agent: t.group
            ? {
                employeeId: t.group.employeeId,
                threadId: t.group.threadId,
                control: "you",
              }
            : undefined,
        }),
      ),
    [allTabs, mode, group],
  );
  const slot = state?.slots[slotId];
  const activeId = slot?.activeTabId ?? "";
  const active = allTabs.find((t) => t.id === activeId);
  const pushedFind = state?.find[slotId];

  return (
    <div ref={rootRef} className={className}>
      <BrowserPanel
        mode={mode}
        osWindow={osWindow}
        tabs={tabs}
        activeId={activeId}
        emp={emp}
        threads={threads}
        history={[]}
        bookmarks={[]}
        downloads={state?.downloads ?? []}
        page={
          <PageSlot
            slotId={slotId}
            covered={covered}
            insetTop={findOpen ? FIND_INSET : 0}
            elsewhere={!!active && slot?.visibleTabId !== activeId}
            onBringHere={() =>
              active && cmd({ op: "selectTab", slotId, tabId: active.id })
            }
          />
        }
        canBack={active?.canBack ?? false}
        canForward={active?.canForward ?? false}
        zoom={active?.zoom ?? 1}
        find={
          findOpen
            ? {
                query: findQ.query,
                index:
                  pushedFind?.query === findQ.query
                    ? pushedFind.index
                    : findQ.index,
              }
            : null
        }
        findCount={pushedFind?.count ?? 0}
        onFind={(f) => {
          setFindOpen(!!f);
          if (f) setFindQ(f);
          cmd({ op: "find", slotId, find: f });
        }}
        onSelectTab={(id) => cmd({ op: "selectTab", slotId, tabId: id })}
        onNewTab={() =>
          cmd({ op: "newTab", slotId, group: group ?? undefined })
        }
        onCloseTab={(id) => cmd({ op: "closeTab", tabId: id })}
        onNavigate={(url) =>
          cmd({ op: "navigate", slotId, url: toBrowserUrl(url) })
        }
        onBack={() => cmd({ op: "back", slotId })}
        onForward={() => cmd({ op: "forward", slotId })}
        onReload={() => cmd({ op: "reload", slotId })}
        onZoom={(z) => cmd({ op: "zoom", slotId, zoom: z })}
        onPrint={() => cmd({ op: "print", slotId })}
        onDevTools={() => cmd({ op: "devTools", slotId })}
        onShowDownload={(id) => cmd({ op: "showDownload", id })}
        onTakeControl={() => {}}
        onHandBack={() => {}}
        onMode={(m) => m !== "thread" && void cmd({ op: "setMode", mode: m })}
        onClose={() => cmd({ op: "setOpen", open: false })}
        onLibraryChange={(t) => setCovered(t !== null)}
        className="h-full"
      />
    </div>
  );
}

/**
 * The ⌘⇧B surface in the app window: the browser docked beside the chat,
 * with a drag-resize gutter (same 380px min / 70% cap as the prototype).
 */
export function BrowserDock() {
  const enabled = !!bridge();
  const state = useBrowserState();
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem("lilos.browser.width"));
    return w >= 380 ? w : 480;
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(
        Math.max(window.innerWidth - ev.clientX, 380),
        window.innerWidth * 0.7,
      );
      setWidth(w);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      localStorage.setItem(
        "lilos.browser.width",
        String(Math.round(widthRef.current)),
      );
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  if (!enabled || !state?.open || state.mode !== "panel") return null;
  return (
    <div data-browser-dock className="flex min-w-0 shrink-0" style={{ width }}>
      <hr
        aria-label="Resize browser"
        className="m-0 w-1 cursor-col-resize border-0 bg-transparent transition-colors hover:bg-border"
        onPointerDown={drag}
      />
      <BrowserSlotView slotId="panel" mode="panel" className="min-w-0 flex-1" />
    </div>
  );
}

/** A thread's Workbench Browser tab: the same browser, only this thread's
 *  tabs (tabs created here carry the thread's group). */
export function ThreadBrowser({
  conversationId,
  employeeId,
}: {
  conversationId: string;
  employeeId?: string;
}) {
  if (!bridge()) return null;
  return (
    <BrowserSlotView
      slotId={`thread:${conversationId}`}
      mode="thread"
      group={employeeId ? { threadId: conversationId, employeeId } : undefined}
      className="min-h-0 flex-1"
    />
  );
}

/** The popped-out LilOS Browser window's whole page (?bw via argv flag). */
export function BrowserWindowApp() {
  useEffect(() => watchDesktopChrome(), []);
  return (
    <div className="fixed inset-0">
      <BrowserSlotView
        slotId="window"
        mode="window"
        osWindow
        className="h-full"
      />
    </div>
  );
}
