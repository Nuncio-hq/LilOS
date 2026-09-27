/**
 * Issue #32 — Electron-main side of notifications. The renderer ships a
 * DesktopNotification over IPC; main validates it against the contract
 * (renderer compromise can't push arbitrary OS banners), posts a real
 * `Notification`, and routes the click back to the renderer with the
 * conversation id to open.
 */
import { DesktopNotification } from "@lilos/contracts/app";

export interface PostedNotification {
  onClick(cb: () => void): void;
}

export interface NotificationDeps {
  show(opts: { title: string; body: string }): PostedNotification;
  /** Show + focus the window and tell the renderer to open the conversation. */
  openConversation(conversationId: string): void;
  /** Malformed frames land here (logged), never at the OS. */
  onReject?(error: string): void;
}

export function postDesktopNotification(
  raw: unknown,
  deps: NotificationDeps,
): boolean {
  const parsed = DesktopNotification.safeParse(raw);
  if (!parsed.success) {
    deps.onReject?.(parsed.error.message);
    return false;
  }
  const n = parsed.data;
  const handle = deps.show({ title: n.title, body: n.body });
  handle.onClick(() => deps.openConversation(n.conversationId));
  return true;
}
