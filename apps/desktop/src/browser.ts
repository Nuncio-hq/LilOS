import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DESKTOP_BROWSER_CHANNEL,
  DESKTOP_BROWSER_KEY_CHANNEL,
  DESKTOP_BROWSER_SLOT_CHANNEL,
  DESKTOP_BROWSER_STATE_CHANNEL,
  type DesktopBrowserCommand,
  type DesktopBrowserDownload,
  type DesktopBrowserEmployee,
  type DesktopBrowserFind,
  type DesktopBrowserKey,
  type DesktopBrowserMode,
  type DesktopBrowserSlotReport,
  type DesktopBrowserState,
  type DesktopBrowserTab,
  type DesktopBrowserTabGroup,
  type DesktopBrowserThread,
} from "@lilos/contracts/app";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  type Session,
  session,
  shell,
  type WebContents,
  WebContentsView,
} from "electron";
import { nativeWindowChrome } from "./window-chrome";

/**
 * The LilOS Browser host (D-#215): pages live in the main process — one
 * Electron `WebContentsView` per tab on the shared `persist:lilos-browser`
 * partition (a single profile, so a sign-in in any tab or popup is the
 * sign-in everywhere and survives quit). The renderer(s) are pure chrome —
 * tab strip, omnibox, find bar, library — and report where each page slot
 * sits; this host is the single source of truth for tabs, slot assignment,
 * downloads and find state, and pushes the whole snapshot to both chrome
 * renderers on every change (the state is small and the renderers are thin).
 * Tabs persist in browser-state.json; sign-ins via the will-quit cookie
 * flush. Not: `<webview>` (its state lives in the guest, untestable), a
 * BrowserWindow per tab, browser state through the relay, or an
 * agent-facing AppMethod (agent browser tools land separately).
 *
 * Slots: `panel` (the ⌘⇧B browser docked in the app window), `window` (the
 * popped-out browser window, running the same chrome) and
 * `thread:<conversationId>` (a thread's Workbench Browser tab, which may only
 * adopt or open tabs of that thread's group). A tab's view is attached to
 * whichever slot paints it — selecting a tab in another slot moves the view,
 * leaving the old slot to draw its "open elsewhere" affordance.
 */

/** One partition = one browser profile across every tab, popup and window. */
export const BROWSER_PARTITION = "persist:lilos-browser";

const NEWTAB_URL = "lilos://newtab";

/* The chrome forwards these chords from a page back to the owning renderer;
   the page itself never sees them (they're intercepted before input). */
const KEYMAP: Record<string, DesktopBrowserKey> = {
  "meta+f": "find",
  "meta+l": "focusUrl",
  "meta+t": "newTab",
  "meta+w": "closeTab",
  "meta+=": "zoomIn",
  "meta+-": "zoomOut",
  "meta+0": "zoomReset",
  "meta+p": "print",
  "meta+[": "back",
  "meta+]": "forward",
  "meta+r": "reload",
  "alt+meta+i": "devTools",
  f12: "devTools",
};

interface BrowserTabInternal {
  tab: DesktopBrowserTab;
  view: WebContentsView;
  /** The view hasn't been asked to load yet (restored tabs load on show). */
  loaded: boolean;
  /** The View the view is currently attached to, if any. */
  parent?: { removeChildView(v: WebContentsView): void };
}

interface Slot {
  id: string;
  win: BrowserWindow;
  rect: { x: number; y: number; width: number; height: number } | null;
  /* A thread slot's group: which tabs it may adopt/open — its strip is
     filtered to these, so anything else would be invisible. */
  group?: DesktopBrowserTabGroup;
  activeTabId?: string;
  visibleTabId?: string;
}

/** Shape persisted to browser-state.json under the desktop state dir. */
interface PersistedBrowser {
  open: boolean;
  mode: DesktopBrowserMode;
  tabs: Array<Pick<DesktopBrowserTab, "id" | "url" | "title" | "group">>;
  slots: Record<string, { activeTabId?: string }>;
}

function newtabPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>New Tab</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#fff;
       font:13px -apple-system,sans-serif;color:#64748b;user-select:none}
  main{text-align:center}
  .mark{width:44px;height:44px;margin:0 auto 14px;border-radius:12px;
        background:#7c3aed;color:#fff;display:grid;place-items:center;
        font-size:20px;font-weight:600}
</style>
<main><div class="mark">L</div><div>LilOS Browser</div></main>`,
    { headers: { "content-type": "text/html" } },
  );
}

/** Registers the privileged `lilos:` scheme; call before `app.whenReady`. */
export function registerBrowserSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "lilos",
      privileges: { standard: true, secure: true, supportFetchAPI: false },
    },
  ]);
}

export class BrowserHost {
  private readonly ses: Session;
  private readonly stateFile: string;
  private readonly downloadsDir: string;
  private tabs = new Map<string, BrowserTabInternal>();
  private slots = new Map<string, Slot>();
  private downloads: DesktopBrowserDownload[] = [];
  private find = new Map<string, DesktopBrowserFind>();
  private threads: DesktopBrowserThread[] = [];
  private employees: DesktopBrowserEmployee[] = [];
  private open = false;
  private mode: DesktopBrowserMode = "panel";
  private appWindow: BrowserWindow | undefined;
  private browserWindow: BrowserWindow | undefined;
  private seq = 0;
  private cookiesFlushed = false;

  constructor(opts: {
    stateDir: string;
    downloadsDir?: string;
    /** Renderer target for the popped-out browser window. */
    windowTarget: () => { file: string } | { url: string } | undefined;
    windowPreload: () => string;
  }) {
    this.stateFile = join(opts.stateDir, "browser-state.json");
    this.downloadsDir = opts.downloadsDir ?? app.getPath("downloads");
    this.windowTarget = opts.windowTarget;
    this.windowPreload = opts.windowPreload;
    this.ses = session.fromPartition(BROWSER_PARTITION);
    this.ses.protocol.handle("lilos", () => newtabPage());
    /* Sign-in flows legitimately need storage access and clipboard; device
       permissions (camera/mic/geo/HID…) are denied outright — there's no
       prompt UI yet, and silently granting them would make any page a
       recorder. Add a prompt surface before allowing more. */
    const safePerms = new Set([
      "clipboard-read",
      "clipboard-sanitized-write",
      "storage-access",
      "top-level-storage-access",
      "fullscreen",
      "window-management",
    ]);
    this.ses.setPermissionRequestHandler((_wc, perm, cb) =>
      cb(safePerms.has(perm)),
    );
    this.ses.on("will-download", (_e, item) => {
      const name = this.claimDownloadName(item.getFilename() || "download");
      const savePath = join(this.downloadsDir, name);
      item.setSavePath(savePath);
      const dl: DesktopBrowserDownload = {
        id: `dl-${++this.seq}`,
        name,
        size: "",
        progress: 0,
      };
      this.downloadPaths.set(dl.id, savePath);
      this.downloads.unshift(dl);
      item.on("updated", (_e2, state) => {
        const total = item.getTotalBytes();
        dl.progress = total > 0 ? item.getReceivedBytes() / total : 0;
        dl.size = this.humanSize(item.getReceivedBytes(), total);
        if (state === "interrupted") dl.progress = undefined;
        this.push();
      });
      item.once("done", () => {
        dl.progress = undefined;
        dl.when = "Now";
        this.push();
      });
      this.push();
    });
    this.restore();
    this.wireIpc();
    app.on("before-quit", () => this.persistNow());
    /* Partition cookie writes are buffered in memory; the flush must
       finish before the process exits or sign-ins don't survive restart. */
    app.on("will-quit", (e) => {
      if (this.cookiesFlushed) return;
      e.preventDefault();
      this.ses.cookies
        .flushStore()
        .catch(() => {})
        .then(() => {
          this.cookiesFlushed = true;
          app.quit();
        });
    });
  }

  private readonly windowTarget: () =>
    | { file: string }
    | { url: string }
    | undefined;
  private readonly windowPreload: () => string;

  /* ------------------------------ ipc ---------------------------------- */

  private wireIpc(): void {
    ipcMain.handle(DESKTOP_BROWSER_CHANNEL, (e, cmd: DesktopBrowserCommand) =>
      this.command(e.sender, cmd),
    );
    ipcMain.on(DESKTOP_BROWSER_SLOT_CHANNEL, (e, r: DesktopBrowserSlotReport) =>
      this.reportSlot(e.sender, r),
    );
  }

  /** The app window hosts the `panel` and `thread:*` slots. */
  attachAppWindow(win: BrowserWindow): void {
    this.appWindow = win;
    win.on("closed", () => {
      if (this.appWindow === win) this.appWindow = undefined;
      for (const [id, s] of this.slots)
        if (s.win === win) this.unregisterSlot(id);
    });
    win.webContents.on("did-finish-load", () => this.push());
    if (this.open && this.mode === "window") this.ensureBrowserWindow();
  }

  /** Menu item / renderer toggle: ⌘⇧B opens the browser, or closes it. */
  toggle(): void {
    this.command(undefined, { op: "setOpen", open: !this.open });
  }

  /* ---------------------------- commands ------------------------------- */

  private command(
    sender: WebContents | undefined,
    cmd: DesktopBrowserCommand,
  ): DesktopBrowserState | undefined {
    switch (cmd.op) {
      case "getState":
        return this.state();
      case "setOpen":
        this.open = cmd.open;
        if (this.open && this.mode === "window") this.ensureBrowserWindow();
        if (!this.open) this.browserWindow?.close();
        break;
      case "setMode":
        this.mode = cmd.mode;
        if (this.open && this.mode === "window") this.ensureBrowserWindow();
        else if (this.mode === "panel") this.browserWindow?.close();
        break;
      case "newTab":
        this.newTab(cmd.slotId, sender, cmd.url, cmd.group);
        break;
      case "closeTab":
        this.closeTab(cmd.tabId);
        break;
      case "selectTab":
        this.selectTab(cmd.slotId, cmd.tabId);
        break;
      case "navigate":
        this.slotView(cmd.slotId)?.webContents.loadURL(cmd.url);
        break;
      case "back":
        this.slotView(cmd.slotId)?.webContents.navigationHistory.goBack();
        break;
      case "forward":
        this.slotView(cmd.slotId)?.webContents.navigationHistory.goForward();
        break;
      case "reload":
        this.slotView(cmd.slotId)?.webContents.reload();
        break;
      case "zoom":
        this.zoom(cmd.slotId, cmd.zoom);
        break;
      case "find":
        this.findIn(cmd.slotId, cmd.find);
        break;
      case "print":
        this.slotView(cmd.slotId)?.webContents.print({});
        break;
      case "devTools":
        this.slotView(cmd.slotId)?.webContents.openDevTools({
          mode: "detach",
        });
        break;
      case "showDownload": {
        /* Saved paths stay main-side (not pushed to renderers). */
        const p = this.downloadPaths.get(cmd.id);
        if (p) shell.showItemInFolder(p);
        break;
      }
      case "setContext":
        this.threads = cmd.threads;
        this.employees = cmd.employees;
        break;
    }
    this.push();
    this.persistSoon();
    return undefined;
  }

  private downloadPaths = new Map<string, string>();

  /* ------------------------------ tabs --------------------------------- */

  private newTab(
    slotId: string | undefined,
    sender: WebContents | undefined,
    url: string | undefined,
    group: DesktopBrowserTab["group"],
  ): string {
    const id = `tab-${++this.seq}-${Date.now().toString(36)}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
      },
    });
    const tab: DesktopBrowserTab = {
      id,
      url: url ?? NEWTAB_URL,
      title: "New Tab",
      loading: false,
      canBack: false,
      canForward: false,
      zoom: 1,
      group,
    };
    const rec: BrowserTabInternal = { tab, view, loaded: false };
    this.tabs.set(id, rec);
    this.wireView(rec);
    const slot = slotId ? this.slots.get(slotId) : undefined;
    if (slot) this.assign(slot.id, id);
    else if (sender) {
      // A slot-less request (menu ⌘T before a slot reported): give it the
      // window that asked, in the slot that window owns or `panel`.
      const win = BrowserWindow.fromWebContents(sender);
      const fallback =
        [...this.slots.values()].find((s) => s.win === win)?.id ??
        (win === this.browserWindow ? "window" : "panel");
      if (this.slots.has(fallback)) this.assign(fallback, id);
    }
    return id;
  }

  private wireView(rec: BrowserTabInternal): void {
    const wc = rec.view.webContents;
    const sync = () => {
      const t = rec.tab;
      t.url = wc.getURL() || t.url;
      t.canBack = wc.navigationHistory.canGoBack();
      t.canForward = wc.navigationHistory.canGoForward();
      this.push();
    };
    wc.on("page-title-updated", (_e, title) => {
      rec.tab.title = title;
      this.push();
    });
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("did-start-loading", () => {
      rec.tab.loading = true;
      this.push();
    });
    wc.on("did-stop-loading", () => {
      rec.tab.loading = false;
      sync();
    });
    wc.on("found-in-page", (_e, r) => {
      const slotId = this.slotOf(rec.tab.id);
      if (!slotId) return;
      this.find.set(slotId, {
        query: this.find.get(slotId)?.query ?? "",
        index: Math.max(0, r.activeMatchOrdinal - 1),
        count: r.matches,
      });
      this.push();
    });
    // ⌘ chords inside a page belong to the chrome, not the site.
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const chord = `${input.alt ? "alt+" : ""}${input.meta || input.control ? "meta+" : ""}${input.shift ? "shift+" : ""}${key}`;
      const mapped = KEYMAP[chord];
      if (!mapped) return;
      e.preventDefault();
      const slotId = this.slotOf(rec.tab.id);
      const win = slotId ? this.slots.get(slotId)?.win : undefined;
      win?.webContents.send(DESKTOP_BROWSER_KEY_CHANNEL, {
        key: mapped,
        slotId,
      });
    });
    /* OAuth/sign-in popups open as real child windows on the same profile,
       but only for document URLs — javascript:/data:/file: popups are a
       script-injection vector and get nothing. */
    wc.setWindowOpenHandler(({ url }) => {
      if (!/^(https?|lilos):/i.test(url)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: BROWSER_PARTITION, sandbox: true },
        },
      };
    });
  }

  private closeTab(tabId: string): void {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    this.tabs.delete(tabId);
    // WebContentsView has no destroy; detaching + closing the contents is
    // the teardown.
    rec.parent?.removeChildView(rec.view);
    rec.view.webContents.close();
    for (const [id, s] of this.slots) {
      if (s.visibleTabId === tabId) s.visibleTabId = undefined;
      if (s.activeTabId === tabId) {
        /* The refill must respect the slot's group — a thread strip can't
           show another thread's (or the user's) tabs. */
        const next = [...this.tabs.values()].find(
          (r) => !s.group || r.tab.group?.threadId === s.group.threadId,
        )?.tab.id;
        if (next) this.assign(id, next);
        else {
          s.activeTabId = undefined;
          // An emptied slot gets a fresh tab, like a browser whose last
          // tab you close — the chrome stays usable without a dead pane.
          this.newTab(id, s.win.webContents, undefined, s.group);
        }
      }
    }
  }

  private slotView(slotId: string): WebContentsView | undefined {
    const id = this.slots.get(slotId)?.visibleTabId;
    return id ? this.tabs.get(id)?.view : undefined;
  }

  private slotOf(tabId: string): string | undefined {
    for (const [id, s] of this.slots) if (s.visibleTabId === tabId) return id;
    return undefined;
  }

  /* ------------------------------ slots -------------------------------- */

  private reportSlot(sender: WebContents, r: DesktopBrowserSlotReport): void {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return;
    if (r.rect === null) {
      const s = this.slots.get(r.slotId);
      if (s) {
        s.rect = null;
        const v = this.tabs.get(s.visibleTabId ?? "")?.view;
        v?.setVisible(false);
      }
      this.push();
      return;
    }
    const existing = this.slots.get(r.slotId);
    const rect = {
      x: Math.round(r.rect.x),
      y: Math.round(r.rect.y),
      width: Math.round(r.rect.width),
      height: Math.round(r.rect.height),
    };
    if (existing) {
      existing.rect = rect;
    } else {
      this.slots.set(r.slotId, { id: r.slotId, win, rect, group: r.group });
      // A freshly-registered slot gets the remembered selection back, or a
      // new tab when it had none. A thread slot may only adopt tabs of its
      // own group — anything else is invisible to its filtered strip.
      const remembered = this.persistedSlots[r.slotId]?.activeTabId;
      const slot = this.slots.get(r.slotId);
      if (slot) {
        if (remembered && this.tabs.has(remembered)) {
          this.assign(r.slotId, remembered);
        } else if (!slot.activeTabId) {
          const reuse = [...this.tabs.values()].find(
            (rec) =>
              this.slotOf(rec.tab.id) === undefined &&
              (!r.group || rec.tab.group?.threadId === r.group.threadId),
          );
          if (reuse) this.assign(r.slotId, reuse.tab.id);
          else this.newTab(r.slotId, sender, undefined, r.group);
        }
      }
    }
    const s = this.slots.get(r.slotId);
    if (s?.visibleTabId) {
      const v = this.tabs.get(s.visibleTabId)?.view;
      v?.setBounds(rect);
      v?.setVisible(true);
    }
    this.push();
  }

  private unregisterSlot(slotId: string): void {
    const s = this.slots.get(slotId);
    if (!s) return;
    this.slots.delete(slotId);
    const v = s.visibleTabId ? this.tabs.get(s.visibleTabId)?.view : undefined;
    if (v) v.setVisible(false);
    this.find.delete(slotId);
    this.push();
  }

  private assign(slotId: string, tabId: string): void {
    const s = this.slots.get(slotId);
    const rec = this.tabs.get(tabId);
    if (!s || !rec) return;
    /* A thread slot can never paint a tab outside its group — its strip is
       filtered to the group, so it would hold an invisible active tab. */
    if (s.group && rec.tab.group?.threadId !== s.group.threadId) return;
    // The view moves to wherever the tab is now selected: detach from any
    // previous parent and hand it to this slot's window.
    const prevSlot = this.slotOf(tabId);
    if (prevSlot && prevSlot !== slotId) {
      const ps = this.slots.get(prevSlot);
      if (ps?.visibleTabId === tabId) ps.visibleTabId = undefined;
    }
    if (s.visibleTabId && s.visibleTabId !== tabId) {
      this.tabs.get(s.visibleTabId)?.view.setVisible(false);
    }
    if (prevSlot !== slotId || s.visibleTabId !== tabId) {
      if (rec.parent !== s.win.contentView) {
        rec.parent?.removeChildView(rec.view);
        s.win.contentView.addChildView(rec.view);
        rec.parent = s.win.contentView;
      }
      if (!rec.loaded) {
        rec.loaded = true;
        void rec.view.webContents.loadURL(rec.tab.url);
      }
    }
    s.activeTabId = tabId;
    s.visibleTabId = tabId;
    if (s.rect) {
      rec.view.setBounds(s.rect);
      rec.view.setVisible(true);
    } else {
      rec.view.setVisible(false);
    }
    rec.view.webContents.setZoomFactor(rec.tab.zoom);
  }

  private selectTab(slotId: string, tabId: string): void {
    this.assign(slotId, tabId);
  }

  /* --------------------------- find/zoom ------------------------------- */

  private zoom(slotId: string, zoom: number): void {
    const s = this.slots.get(slotId);
    const rec = s?.visibleTabId ? this.tabs.get(s.visibleTabId) : undefined;
    if (!rec) return;
    rec.tab.zoom = Math.min(3, Math.max(0.25, zoom));
    rec.view.webContents.setZoomFactor(rec.tab.zoom);
  }

  private findIn(
    slotId: string,
    find: { query: string; index: number } | null,
  ): void {
    const s = this.slots.get(slotId);
    const rec = s?.visibleTabId ? this.tabs.get(s.visibleTabId) : undefined;
    if (!rec) return;
    const prev = this.find.get(slotId);
    if (find === null || find.query === "") {
      rec.view.webContents.stopFindInPage("clearSelection");
      this.find.delete(slotId);
      return;
    }
    const sameQuery = prev && prev.query === find.query;
    const forward = sameQuery ? find.index >= prev.index : true;
    rec.view.webContents.findInPage(find.query, {
      forward,
      findNext: !!sameQuery,
    });
    this.find.set(slotId, {
      query: find.query,
      index: find.index,
      count: prev?.count ?? 0,
    });
    /* found-in-page replies are unreliable on a view that has been
       detached and re-attached (some arrive, many never emit). The match
       count the bar shows can't wait on that channel — count directly in
       the page instead. */
    void rec.view.webContents
      .executeJavaScript(
        `(() => {
          try {
            const q = ${JSON.stringify(find.query)}.toLowerCase();
            const t = (document.body?.innerText || "").toLowerCase();
            let i = -1, n = 0;
            while ((i = t.indexOf(q, i + 1)) !== -1) n++;
            return n;
          } catch { return 0; }
        })()`,
        true,
      )
      .then((n) => {
        const cur = this.find.get(slotId);
        if (cur && cur.query === find.query) {
          this.find.set(slotId, { ...cur, count: n });
          this.push();
        }
      })
      .catch(() => {});
  }

  /* --------------------------- pop-out --------------------------------- */

  private ensureBrowserWindow(): void {
    if (this.browserWindow) {
      this.browserWindow.focus();
      return;
    }
    const target = this.windowTarget();
    if (!target) return;
    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      title: "LilOS Browser",
      ...nativeWindowChrome("app"),
      webPreferences: {
        preload: this.windowPreload(),
        contextIsolation: true,
        sandbox: true,
        additionalArguments: ["--lilos-browser-window=1"],
      },
    });
    this.browserWindow = win;
    win.on("closed", () => {
      if (this.browserWindow === win) this.browserWindow = undefined;
      for (const [id, s] of [...this.slots])
        if (s.win === win) this.unregisterSlot(id);
      // Closing the pop-out while it is the browser's home closes the
      // browser (like the panel's close affordance). A close caused by the
      // mode toggle back to "panel" is not a close: the dock takes over.
      if (this.mode === "window") {
        this.mode = "panel";
        this.open = false;
      }
      this.push();
      this.persistSoon();
    });
    win.webContents.on("did-finish-load", () => this.push());
    if ("file" in target)
      void win.loadFile(target.file, { query: { bw: "1" } });
    else void win.loadURL(`${target.url}?bw=1`);
  }

  /* --------------------------- persistence ------------------------------ */

  private persistedSlots: Record<string, { activeTabId?: string }> = {};
  private persistTimer: NodeJS.Timeout | undefined;

  private persistSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 300);
  }

  /** Quit is too late for the debounce — flush synchronously. */
  private persistNow(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persist();
  }

  private persist(): void {
    const p: PersistedBrowser = {
      open: this.open,
      mode: this.mode,
      tabs: [...this.tabs.values()].map((r) => ({
        id: r.tab.id,
        url: r.tab.url,
        title: r.tab.title,
        group: r.tab.group,
      })),
      slots: Object.fromEntries(
        [...this.slots.entries()].map(([id, s]) => [
          id,
          { activeTabId: s.activeTabId },
        ]),
      ),
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(p));
    } catch {
      /* state dir may not exist yet on first launch */
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.stateFile)) return;
      const p = JSON.parse(
        readFileSync(this.stateFile, "utf8"),
      ) as PersistedBrowser;
      this.open = p.open;
      this.mode = p.mode;
      this.persistedSlots = p.slots ?? {};
      for (const t of p.tabs) {
        const view = new WebContentsView({
          webPreferences: {
            partition: BROWSER_PARTITION,
            sandbox: true,
            contextIsolation: true,
          },
        });
        const rec: BrowserTabInternal = {
          tab: {
            ...t,
            loading: false,
            canBack: false,
            canForward: false,
            zoom: 1,
          },
          view,
          loaded: false,
        };
        this.tabs.set(t.id, rec);
        this.wireView(rec);
      }
    } catch {
      /* a corrupt state file must never take the app down */
    }
  }

  /* ------------------------------ misc --------------------------------- */

  private humanSize(got: number, total: number): string {
    const fmt = (n: number) =>
      n >= 1e9
        ? `${(n / 1e9).toFixed(1)} GB`
        : n >= 1e6
          ? `${(n / 1e6).toFixed(1)} MB`
          : `${Math.max(1, Math.round(n / 1e3))} KB`;
    return total > 0 ? `${fmt(got)} of ${fmt(total)}` : fmt(got);
  }

  private claimDownloadName(name: string): string {
    if (!existsSync(this.downloadsDir))
      mkdirSync(this.downloadsDir, { recursive: true });
    if (!existsSync(join(this.downloadsDir, name))) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!existsSync(join(this.downloadsDir, candidate))) return candidate;
    }
  }

  private state(): DesktopBrowserState {
    return {
      open: this.open,
      mode: this.mode,
      tabs: [...this.tabs.values()].map((r) => r.tab),
      slots: Object.fromEntries(
        [...this.slots.entries()].map(([id, s]) => [
          id,
          { activeTabId: s.activeTabId, visibleTabId: s.visibleTabId },
        ]),
      ),
      downloads: this.downloads,
      threads: this.threads,
      employees: this.employees,
      find: Object.fromEntries(this.find),
    };
  }

  /** Push the snapshot to every live chrome renderer. */
  private push(): void {
    const state = this.state();
    for (const win of [this.appWindow, this.browserWindow]) {
      if (win && !win.webContents.isDestroyed())
        win.webContents.send(DESKTOP_BROWSER_STATE_CHANNEL, state);
    }
  }
}
