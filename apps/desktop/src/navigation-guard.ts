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

/* Temporary diagnosis for #565's Linux CI leg — LILOS_DEBUG_NAV=1 records
   every navigation event (plus getURL()/isLoading() at emit time) into
   globalThis.__navEvents and stderr so the e2e spec can dump the exact event
   stream a foreign navigation took. Removed before the PR lands. */
const DEBUG_NAV = process.env.LILOS_DEBUG_NAV === "1";
const navLog = (msg: string): void => {
  const g = globalThis as { __navEvents?: string[] };
  if (!g.__navEvents) g.__navEvents = [];
  g.__navEvents.push(msg);
  console.error(`[nav-debug] ${msg}`);
};
const NAV_EVENTS = [
  "will-navigate",
  "will-redirect",
  "did-start-navigation",
  "did-redirect-navigation",
  "did-navigate",
  "did-navigate-in-page",
  "did-start-loading",
  "dom-ready",
  "did-finish-load",
  "did-fail-load",
  "did-fail-provisional-load",
  "did-stop-loading",
] as const;

/* The probe reaches past GuardableContents (Electron-only getters + the
   wider event set), so it binds the structural slice itself — the knob is
   dead code in unit tests and production (env unset). */
function watchNav(contents: GuardableContents, tag: string): void {
  const probe = contents as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): void;
    getURL?(): string;
    isLoading?(): boolean;
  };
  const state = () =>
    `getURL=${probe.getURL?.() ?? "?"} loading=${probe.isLoading?.() ?? "?"}`;
  for (const event of NAV_EVENTS) {
    probe.on(event, (_e: unknown, ...rest: unknown[]) => {
      const detail = rest
        .map((a) => (typeof a === "object" ? "<obj>" : JSON.stringify(a)))
        .join(" ");
      navLog(`${tag} ${event} ${detail} ${state()}`);
    });
  }
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
  if (DEBUG_NAV) watchNav(contents, `guard(${appUrl})`);
  contents.setWindowOpenHandler(({ url }) => {
    if (DEBUG_NAV) navLog(`window.open ${url}`);
    if (canOpenExternal(url)) openExternal(url);
    return { action: "deny" };
  });
  const denyForeign = (event: NavEvent, url: string) => {
    if (isAppNavigation(appUrl, url)) return;
    if (DEBUG_NAV) navLog(`denyForeign prevent ${url}`);
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
    if (isAppNavigation(appUrl, url)) return;
    if (DEBUG_NAV) navLog(`snap-back loadURL(${appUrl}) after commit ${url}`);
    void Promise.resolve(contents.loadURL(appUrl)).then(
      () => DEBUG_NAV && navLog(`snap-back resolved for ${appUrl}`),
      (e) => DEBUG_NAV && navLog(`snap-back rejected: ${e}`),
    );
  });
}
