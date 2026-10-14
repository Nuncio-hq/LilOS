import { z } from "zod";

/**
 * LilOS Browser wire contract: the boundary between the apps/web renderer(s)
 * and the apps/desktop main process's browser host (a tree of Electron
 * `WebContentsView`s on the `persist:lilos-browser` partition).
 *
 * The main process owns all browser state — tabs (one WebContentsView each),
 * which slot paints which view, downloads, find results. Renderers are pure
 * chrome: they draw the tab strip / omnibox / find bar / library and report
 * the page slot's bounds; the host positions native views on top. Two
 * renderers can be live at once (the app window and the popped-out browser
 * window), so state is always pushed as one complete snapshot — no deltas.
 *
 * Nothing here reaches the relay or an engine: this is shell-internal IPC,
 * so no AppMethod exists for it (agent browser tools land separately).
 */

/** renderer → main (invoke): one command envelope for every browser op. */
export const DESKTOP_BROWSER_CHANNEL = "lilos:browser" as const;
/** main → renderer: the full browser snapshot, on every change. */
export const DESKTOP_BROWSER_STATE_CHANNEL = "lilos:browser-state" as const;
/** renderer → main (send): a page slot's latest viewport rect, or null when
 *  the slot unmounted/hid — the host hides the attached view on null. */
export const DESKTOP_BROWSER_SLOT_CHANNEL = "lilos:browser-slot" as const;
/** main → renderer: a browser chord pressed inside a page's WebContentsView
 *  (⌘F, ⌘L, ⌘T…) — the page itself never sees it; the chrome owns the key. */
export const DESKTOP_BROWSER_KEY_CHANNEL = "lilos:browser-key" as const;

/**
 * A page slot: a rectangle in some window that paints one tab's view.
 * - `panel` — the ⌘⇧B browser docked beside the chat in the app window.
 * - `window` — the popped-out browser window's page area.
 * - `thread:<conversationId>` — a thread's Workbench Browser tab.
 */
export type DesktopBrowserSlotId = string;

/** Where the shared browser chrome lives. */
export type DesktopBrowserMode = "panel" | "window";

/** A thread's ownership mark on a tab (employee avatar + group). */
export const DesktopBrowserTabGroup = z.strictObject({
  threadId: z.string().min(1),
  employeeId: z.string().min(1),
});
export type DesktopBrowserTabGroup = z.infer<typeof DesktopBrowserTabGroup>;

/** One browser tab as the chrome needs it (the host owns the real view). */
export const DesktopBrowserTab = z.strictObject({
  id: z.string().min(1),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canBack: z.boolean(),
  canForward: z.boolean(),
  /** 1 = 100%. Per tab; not persisted across restarts. */
  zoom: z.number().positive(),
  /** Thread-owned tabs group under the thread (absent = the user's own). */
  group: DesktopBrowserTabGroup.optional(),
});
export type DesktopBrowserTab = z.infer<typeof DesktopBrowserTab>;

/** Per-slot selection state. */
export const DesktopBrowserSlotState = z.strictObject({
  /** The tab this slot has selected (may not be painted here). */
  activeTabId: z.string().optional(),
  /** The tab whose view is actually attached to this slot right now — a
      tab painted elsewhere leaves this different or absent, and the slot
      draws its "showing elsewhere" affordance instead of the page. */
  visibleTabId: z.string().optional(),
});
export type DesktopBrowserSlotState = z.infer<typeof DesktopBrowserSlotState>;

/** Find-in-page state for one slot. */
export const DesktopBrowserFind = z.strictObject({
  query: z.string(),
  /** Zero-based ordinal of the current match (display "n of m"). */
  index: z.int().min(0),
  /** Total matches on the page; 0 = no results yet or none found. */
  count: z.int().min(0),
});
export type DesktopBrowserFind = z.infer<typeof DesktopBrowserFind>;

export const DesktopBrowserDownload = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  size: z.string(),
  /** 0..1 while in flight; absent once finished/failed. */
  progress: z.number().min(0).max(1).optional(),
  when: z.string().optional(),
});
export type DesktopBrowserDownload = z.infer<typeof DesktopBrowserDownload>;

/** A thread label for the strip's group chips — pushed by the app window
 *  (the relay's owner) so the relay-less pop-out window can render too. */
export const DesktopBrowserThread = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  employeeId: z.string(),
});
export type DesktopBrowserThread = z.infer<typeof DesktopBrowserThread>;

/** The strip's avatar data for an employee (name + presence only). */
export const DesktopBrowserEmployee = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  status: z.string().optional(),
});
export type DesktopBrowserEmployee = z.infer<typeof DesktopBrowserEmployee>;

/** The full pushed snapshot. */
export const DesktopBrowserState = z.strictObject({
  /** Whether the shared browser is open at all. */
  open: z.boolean(),
  mode: z.enum(["panel", "window"]),
  tabs: z.array(DesktopBrowserTab),
  slots: z.record(z.string(), DesktopBrowserSlotState),
  downloads: z.array(DesktopBrowserDownload),
  threads: z.array(DesktopBrowserThread),
  employees: z.array(DesktopBrowserEmployee),
  find: z.record(z.string(), DesktopBrowserFind),
});
export type DesktopBrowserState = z.infer<typeof DesktopBrowserState>;

/** Every renderer→host command. */
export const DesktopBrowserCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("getState") }),
  z.strictObject({ op: z.literal("setOpen"), open: z.boolean() }),
  z.strictObject({
    op: z.literal("setMode"),
    mode: z.enum(["panel", "window"]),
  }),
  z.strictObject({
    op: z.literal("newTab"),
    slotId: z.string().min(1),
    url: z.string().optional(),
    group: DesktopBrowserTabGroup.optional(),
  }),
  z.strictObject({ op: z.literal("closeTab"), tabId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("selectTab"),
    slotId: z.string().min(1),
    tabId: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("navigate"),
    slotId: z.string().min(1),
    url: z.string().min(1),
  }),
  z.strictObject({ op: z.literal("back"), slotId: z.string().min(1) }),
  z.strictObject({ op: z.literal("forward"), slotId: z.string().min(1) }),
  z.strictObject({ op: z.literal("reload"), slotId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("zoom"),
    slotId: z.string().min(1),
    zoom: z.number().positive(),
  }),
  z.strictObject({
    op: z.literal("find"),
    slotId: z.string().min(1),
    /** null closes the bar and clears the page's highlights. */
    find: z
      .strictObject({ query: z.string(), index: z.int().min(0) })
      .nullable(),
  }),
  z.strictObject({ op: z.literal("print"), slotId: z.string().min(1) }),
  z.strictObject({ op: z.literal("devTools"), slotId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("showDownload"),
    id: z.string().min(1),
  }),
  /* App-window-only push of relay context (thread titles + employee
     names/status) so every chrome can label groups — the pop-out window
     has no relay connection of its own. */
  z.strictObject({
    op: z.literal("setContext"),
    threads: z.array(DesktopBrowserThread),
    employees: z.array(DesktopBrowserEmployee),
  }),
]);
export type DesktopBrowserCommand = z.infer<typeof DesktopBrowserCommand>;

/** A slot's reported geometry, in the window's content-view coordinates. */
export const DesktopBrowserSlotReport = z.strictObject({
  slotId: z.string().min(1),
  rect: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
});
export type DesktopBrowserSlotReport = z.infer<typeof DesktopBrowserSlotReport>;

/** The chords main intercepts inside a tab's page and forwards to chrome. */
export const DESKTOP_BROWSER_KEYS = [
  "find",
  "focusUrl",
  "newTab",
  "closeTab",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "print",
  "back",
  "forward",
  "reload",
  "devTools",
] as const;
export type DesktopBrowserKey = (typeof DESKTOP_BROWSER_KEYS)[number];
