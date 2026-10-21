/**
 * Native macOS window chrome (D-#232): every LilOS window uses the
 * `hiddenInset` title-bar style — no separate title bar, the traffic lights
 * are inset into the v3 shell's one toolbar row (#797), centred on it — plus
 * sidebar vibrancy so the sidebar shows the desktop through the window's left
 * column. The renderer owns the drag regions (`-webkit-app-region`:
 * `lilos-drag` toolbar segments, interactive children no-drag —
 * apps/web/src/index.css), so these options are identical for the app and the
 * status window. It also pushes its theme to `nativeTheme.themeSource`
 * (main.ts) so the vibrancy material matches the app tokens. Not: a default
 * framed window, or a frameless one with custom-drawn traffic lights (loses
 * native drag/zoom/full-screen).
 */

import { DESKTOP_FULLSCREEN_CHANNEL } from "@lilos/contracts/app";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/** The toolbar row's height (`--v3-toolbar-h` under html[data-desktop] in
    apps/web/src/index.css); the lights centre on it. */
export const TOOLBAR_HEIGHT = 52;

/** The buttons' diameter, measured on a macOS 26 window capture (ac-232 and
    the #797 evidence): 14px discs at y = `trafficLightPosition.y`. Before
    macOS 26 they are 12px, which puts their centre 1px above the row's. The
    position is the top-left of the cluster, so centring it on the row is
    (row - size) / 2. */
export const TRAFFIC_LIGHT_SIZE = 14;

/** The x where the green button's right edge sits, worst case: the inset is
    x=16 and the three-button cluster spans ~52-62px depending on macOS
    version and display scale (measured ~62 on a Retina box, ~54 at 1x). The
    toolbar's leftmost segment reserves this plus the ~10px gap macOS leaves
    between the lights and content; e2e ac-232 asserts both. */
export const TRAFFIC_LIGHTS_END = 78;

/** BrowserWindow options shared by the app and status windows. */
export function nativeWindowChrome(
  _kind: "app" | "status" = "app",
): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: "hiddenInset",
    // The lights centred on the toolbar row vertically; x matches the
    // sidebar's px-4 content edge.
    trafficLightPosition: {
      x: 16,
      y: (TOOLBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2,
    },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    // Vibrancy needs the page to paint the window area transparently; the
    // renderer scopes that to html[data-desktop].
    backgroundColor: "#00000000",
  };
}

/** Push the window's full-screen state to the renderer — on every change,
 * and on (re)load so a reload while full-screen is not left stale. */
export function watchWindowChrome(win: BrowserWindow): void {
  const send = () =>
    win.webContents.send(DESKTOP_FULLSCREEN_CHANNEL, win.isFullScreen());
  win.on("enter-full-screen", send);
  win.on("leave-full-screen", send);
  win.webContents.on("did-finish-load", send);
}
