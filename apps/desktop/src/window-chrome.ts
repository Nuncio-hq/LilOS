/**
 * Native macOS window chrome (issue #232): every LilOS window uses the
 * `hiddenInset` title-bar style — no separate title bar, the traffic lights
 * are inset into the sidebar's 56px header row — plus sidebar vibrancy so
 * the sidebar shows the desktop through the window's left column. The
 * renderer owns the drag regions (`-webkit-app-region`), so these options
 * are identical for the app and the status window. Windows are
 * square-cornered: a rounded silhouette leaves a corner notch no renderer
 * surface can paint, so the desktop shows through as a light sliver.
 */

import { DESKTOP_FULLSCREEN_CHANNEL } from "@lilos/contracts/app";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/** Sidebar header height (`h-14` in packages/ui); the lights centre on it. */
export const SIDEBAR_HEADER_HEIGHT = 56;

/** The x where the green button's right edge sits, worst case: the inset is
    x=16 and the three-button cluster spans ~52-62px depending on macOS
    version and display scale (measured ~62 on a Retina box, ~54 at 1x). The
    sidebar header's reserve must clear this plus the ~10px gap macOS leaves
    between the lights and content; e2e ac-232 asserts both. */
export const TRAFFIC_LIGHTS_END = 78;

/** BrowserWindow options shared by the app and status windows. */
export function nativeWindowChrome(
  _kind: "app" | "status" = "app",
): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: "hiddenInset",
    // 12px lights vertically centred on the 56px header; x matches the
    // sidebar's px-4 content edge.
    trafficLightPosition: { x: 16, y: 22 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    // Vibrancy needs the page to paint the window area transparently; the
    // renderer scopes that to html[data-desktop].
    backgroundColor: "#00000000",
    // A rounded silhouette leaves an unpainted corner notch the desktop
    // shows through; against light wallpaper it reads as a light sliver
    // (issue #284). Square corners keep every edge uniform.
    roundedCorners: false,
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
