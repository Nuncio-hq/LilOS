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
  platform?: string;
  /** True in the Electron shell (any window with the preload); absent in a
   * plain browser tab — the app scopes all window-chrome CSS to it (#232). */
  isDesktop?: boolean;
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
}
