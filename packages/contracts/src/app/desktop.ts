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
  /** true in the Electron shell — the OS window is the frame (#246). */
  isDesktop?: boolean;
  platform?: string;
  notifications?: {
    post(notification: DesktopNotification): void;
  };
  /** Subscribe to "open this conversation" requests (notification clicks).
   * Returns an unsubscribe function. */
  onOpenConversation?: (cb: (conversationId: string) => void) => () => void;
}
