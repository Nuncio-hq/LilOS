import { DESKTOP_FULLSCREEN_CHANNEL } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  nativeWindowChrome,
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHT_SIZE,
  watchWindowChrome,
} from "../src/window-chrome";

/**
 * Issue #232 — native macOS window chrome. Each acceptance criterion maps to
 * named tests; the on-screen evidence lives in e2e/ac-232-window-chrome.
 */
describe("window chrome options", () => {
  it("AC-1 hides the title bar and centres the traffic lights on the toolbar row", () => {
    const opts = nativeWindowChrome();
    expect(opts.titleBarStyle).toBe("hiddenInset");
    // The buttons sit centred in the 52px toolbar row (#797).
    const { x = 0, y = 0 } = opts.trafficLightPosition ?? {};
    expect(y + TRAFFIC_LIGHT_SIZE / 2).toBe(TOOLBAR_HEIGHT / 2);
    expect(x).toBeGreaterThanOrEqual(8);
    expect(x).toBeLessThanOrEqual(24);
  });

  it("AC-2 paints the sidebar region with macOS sidebar vibrancy", () => {
    const opts = nativeWindowChrome();
    expect(opts.vibrancy).toBe("sidebar");
    expect(opts.visualEffectState).toBe("followWindow");
    // An opaque backgroundColor would paint over the vibrancy material.
    expect(opts.backgroundColor).not.toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("AC-5 the status window gets the same options", () => {
    // One factory serves both windows — there is no second option set to
    // drift away from.
    expect(nativeWindowChrome("status")).toEqual(nativeWindowChrome("app"));
    expect(nativeWindowChrome("app")).toEqual(nativeWindowChrome());
  });
});

describe("full-screen reporting (AC-4)", () => {
  function fakeWindow(fullScreen = false) {
    // Electron flips isFullScreen() before it fires enter/leave-full-screen.
    const state = { fullScreen };
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const sent: Array<[string, unknown]> = [];
    const win = {
      isFullScreen: () => state.fullScreen,
      on: (event: string, cb: (...a: unknown[]) => void) => {
        handlers.set(`win:${event}`, () => {
          if (event === "enter-full-screen") state.fullScreen = true;
          if (event === "leave-full-screen") state.fullScreen = false;
          cb();
        });
      },
      webContents: {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          handlers.set(`wc:${event}`, cb);
        },
        send: (channel: string, payload: unknown) => {
          sent.push([channel, payload]);
        },
      },
    };
    return { win, handlers, sent };
  }

  it("pushes enter/leave-full-screen to the renderer", () => {
    const { win, handlers, sent } = fakeWindow();
    watchWindowChrome(win as never);
    handlers.get("win:enter-full-screen")?.();
    expect(sent.at(-1)).toEqual([DESKTOP_FULLSCREEN_CHANNEL, true]);
    handlers.get("win:leave-full-screen")?.();
    expect(sent.at(-1)).toEqual([DESKTOP_FULLSCREEN_CHANNEL, false]);
  });

  it("sends the current state when the page finishes loading", () => {
    const { win, handlers, sent } = fakeWindow(true);
    watchWindowChrome(win as never);
    handlers.get("wc:did-finish-load")?.();
    expect(sent.at(-1)).toEqual([DESKTOP_FULLSCREEN_CHANNEL, true]);
  });
});
