import { z } from "zod";

/**
 * Desktop bridge contract (issue #32): the boundary between the apps/web
 * renderer and the apps/desktop Electron main process. The renderer posts
 * notifications over `lilos:notify`; main validates them against
 * `DesktopNotification` before touching the OS notification center, so a
 * malformed frame can never reach the OS. Clicking a notification makes
 * main send `lilos:open-conversation` back with the conversation id.
 */

/** IPC channel: renderer → main, carries a DesktopNotification. */
export const DESKTOP_NOTIFY_CHANNEL = "lilos:notify" as const;
/** IPC channel: main → renderer, carries the conversation id to open. */
export const DESKTOP_OPEN_CONVERSATION_CHANNEL =
  "lilos:open-conversation" as const;
/** IPC channel: main → renderer, carries the window's full-screen state
 * (native macOS chrome, issue #232). */
export const DESKTOP_FULLSCREEN_CHANNEL = "lilos:fullscreen" as const;
/** IPC channel: renderer → main, carries the app's theme so the window's
 * vibrancy/appearance follows it (issue #232). */
export const DESKTOP_THEME_CHANNEL = "lilos:theme-source" as const;
/** IPC channel: main → renderer, asks the app window to open Settings
 * (issue #132 — the ⌘, menu item). Distinct from `lilos:open-settings`,
 * which opens macOS Login Items. */
export const DESKTOP_OPEN_SETTINGS_CHANNEL = "lilos:open-app-settings" as const;
/** IPC channel: renderer → main, "the network is back" — the preload
 *  forwards the window's `online` event (no main-process equivalent in
 *  Electron; `net` is poll-only). Triggers a rate-limited update check
 *  (#674). */
export const DESKTOP_ONLINE_CHANNEL = "lilos:online" as const;

/** IPC channel: main → renderer, a Find-menu action the renderer's find
 * bar executes (issue #554): "open" shows/focuses the bar, "next"/"prev"
 * advance the active match. The find itself runs in the renderer — a DOM
 * search painted with CSS Custom Highlights — so the bar's own input and
 * IME composition stay out of it, unlike `webContents.findInPage`. */
export const DESKTOP_FIND_CHANNEL = "lilos:find" as const;

/** What the Edit menu's Find items ask the renderer to do (#554). */
export type DesktopFindAction = "open" | "next" | "prev";

/** The app's stored theme — the window's appearance must match it or the
 * sidebar vibrancy material turns unreadable (dark text on dark vibrancy). */
export type ThemeSource = "light" | "dark" | "system";

/** The #35 update check's verdict as the shell reports it to
 *  Settings → About (#132): "busy" means a check was already in flight.
 *  apps/desktop's `CheckOutcome` is the same set minus "busy". */
export const DESKTOP_UPDATE_OUTCOMES = [
  "disabled",
  "none",
  "apply-ready",
  "failed",
  "busy",
] as const;
export type DesktopUpdateOutcome = (typeof DESKTOP_UPDATE_OUTCOMES)[number];

/** App identity the shell hands the renderer for Settings → About (#132). */
export interface DesktopAbout {
  version: string;
  build?: number;
}

/** The updater's last recorded outcome (status.json, #35/#539): the shell
 *  keeps it so Settings → About can say a rolled-back update plainly. */
export interface DesktopUpdateStatus {
  phase?: string;
  version?: string;
  build?: number;
  detail?: string;
  notified?: boolean;
  at?: number;
}

/** A notification the OS should post; `kind` drives nothing in main — it's
 * for the renderer's bookkeeping and any future styling. */
export const DesktopNotification = z.strictObject({
  /** The conversation a click must open. */
  conversationId: z.string().min(1),
  kind: z.enum(["done", "ask", "failed"]),
  title: z.string().min(1),
  body: z.string().default(""),
});
export type DesktopNotification = z.infer<typeof DesktopNotification>;

/** Endpoints + token the shell hands the renderer (replaces the page's
 * `/lilos-config.json` fetch under Electron). */
export interface DesktopBridgeConfig {
  relayWs: string;
  relayToken: string;
  engineWs: string;
}

/**
 * `window.lilos` as exposed by the preload. Every member is optional so a
 * non-Electron context (plain web, tests) can supply any subset — the
 * renderer guards each call site.
 */
export interface DesktopBridge {
  config?: DesktopBridgeConfig;
  /** True in the Electron shell (any window with the preload); absent in a
   * plain browser tab — the OS window is the frame (#246) and the app scopes
   * all window-chrome CSS to it (#232). */
  isDesktop?: boolean;
  platform?: string;
  /** Native full-screen state (#232 AC-4): the lights hide and the sidebar
   * header drops the inset it kept for them. */
  fullscreen?: {
    /** Latest pushed state — main sends it on load and on every change. */
    current(): boolean;
    /** Subscribe to changes; returns an unsubscribe function. */
    onChange(cb: (fullScreen: boolean) => void): () => void;
  };
  /** Point the window's appearance (vibrancy material, prefers-color-scheme)
   * at the app's theme (desktop only, #232). */
  setThemeSource?: (theme: ThemeSource) => void;
  /** Open the status/first-run window (desktop only). */
  openStatus?: () => Promise<void>;
  notifications?: {
    post(notification: DesktopNotification): void;
  };
  /** Subscribe to "open this conversation" requests (notification clicks).
   * Returns an unsubscribe function. */
  onOpenConversation?: (cb: (conversationId: string) => void) => () => void;
  /** Subscribe to "open Settings" requests — the ⌘, menu item (#132).
   * Returns an unsubscribe function. */
  onOpenSettings?: (cb: () => void) => () => void;
  /** App version + build for Settings → About (#132). */
  about?: () => Promise<DesktopAbout>;
  /** Run the #35 update check now — Settings → About's "Check for
   *  updates" (#132). Absent on plain web, so the control doesn't render. */
  checkUpdate?: () => Promise<DesktopUpdateOutcome>;
  /** The last outcome the updater recorded (#539): `rolled-back`/`failed`
   *  is what the About notice renders with Retry/Details. */
  updateStatus?: () => Promise<DesktopUpdateStatus | undefined>;
  /** Un-skip a rolled-back build and re-run the update check (#539). */
  retryUpdate?: () => Promise<DesktopUpdateOutcome>;
  /** Subscribe to Edit-menu Find actions — ⌘F / ⌘G / ⇧⌘G (#554). Absent on
   *  plain web, where the browser's own find bar owns the chord. Returns
   *  an unsubscribe function. */
  onFind?: (cb: (action: DesktopFindAction) => void) => () => void;
}
