import { pathToFileURL } from "node:url";

/**
 * Issue #565 — the Electron shell's link/navigation policy. Agent-written
 * markdown can carry links on any scheme, so the window boundary is the last
 * line of defense behind the renderer's own sanitizing (#566):
 *
 * - AC-1: `shell.openExternal` fires only for https:/http:/mailto: — a file:/
 *   smb:/app-scheme URL would otherwise open local files and handlers.
 * - AC-2: the window never opens a second window (`setWindowOpenHandler`
 *   denies) and never navigates off the loaded app's own origin
 *   (`will-navigate`/`will-redirect`); web links go to the user's browser.
 *
 * Runtime-neutral: `electron` is a type-only import — main.ts passes the real
 * `shell.openExternal` so this module stays unit-testable.
 */

type NavEvent = { preventDefault(): void };

/** The slice of WebContents the guard needs — a structural type so tests
 *  can drive a fake. */
export interface GuardableContents {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" },
  ): void;
  on(
    event: "will-navigate" | "will-redirect" | "did-navigate",
    listener: (event: NavEvent, url: string) => void,
  ): void;
  loadURL(url: string): unknown;
}

/** Schemes a page may hand to the OS. Everything else is refused. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/** AC-1: is `rawUrl` safe to pass to `shell.openExternal`? */
export const canOpenExternal = (rawUrl: string): boolean => {
  try {
    return EXTERNAL_SCHEMES.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
};

/** The loaded document's URL — the "app's own origin" AC-2 compares against. */
export const appDocumentUrl = (
  target: { file: string } | { url: string },
): string => ("file" in target ? pathToFileURL(target.file).href : target.url);

/** AC-2: is `rawUrl` inside the loaded app's own origin?
 *  http(s): same origin. file: same document path — the packaged app
 *  hash-routes, so any other file path is an injected local-file read. */
export const isAppNavigation = (appUrl: string, rawUrl: string): boolean => {
  try {
    const app = new URL(appUrl);
    const url = new URL(rawUrl);
    if (app.protocol !== url.protocol) return false;
    return app.protocol === "file:"
      ? app.pathname === url.pathname
      : app.origin === url.origin;
  } catch {
    return false;
  }
};

/**
 * Wire AC-1+AC-2 onto one window's webContents: no new windows, no foreign
 * navigation; external links reach the default browser instead.
 * `openExternal` is the caller's `shell.openExternal` wrapper.
 */
export function guardWindow(
  contents: GuardableContents,
  appUrl: string,
  openExternal: (url: string) => void,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternal(url)) openExternal(url);
    return { action: "deny" };
  });
  const denyForeign = (event: NavEvent, url: string) => {
    if (isAppNavigation(appUrl, url)) return;
    event.preventDefault();
    if (canOpenExternal(url)) openExternal(url);
  };
  contents.on("will-navigate", denyForeign);
  contents.on("will-redirect", denyForeign);
  /* The snap-back net: will-navigate never fires for some commits —
     about:blank lands silently, and a renderer-blocked file:/data: nav can
     still commit a chrome-error page (seen on Linux CI). Anything that
     lands off the app document reloads the app instead of staying there. */
  contents.on("did-navigate", (_event, url) => {
    if (!isAppNavigation(appUrl, url)) void contents.loadURL(appUrl);
  });
}
