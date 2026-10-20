// @vitest-environment happy-dom
/* Issue #232 — the renderer side of native macOS window chrome: the Electron
   preload bridge flips `data-desktop`/`data-fullscreen` on <html>, and the
   stylesheet scopes every chrome rule to those attributes so a plain browser
   tab is unchanged (AC-5). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopBridge } from "@lilos/contracts/app";
import { afterEach, describe, expect, test } from "vitest";
import { watchDesktopChrome } from "../src/lib/desktop";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.css"),
  "utf8",
);

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  delete window.lilos;
  document.documentElement.removeAttribute("data-desktop");
  document.documentElement.removeAttribute("data-fullscreen");
});

function fakeBridge(fullScreen = false) {
  let listener: ((fs: boolean) => void) | undefined;
  const bridge: DesktopBridge = {
    isDesktop: true,
    platform: "darwin",
    fullscreen: {
      current: () => fullScreen,
      onChange: (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    },
  };
  return { bridge, emit: (fs: boolean) => listener?.(fs) };
}

describe("desktop chrome attributes", () => {
  test("AC-1/AC-2 data-desktop is set only under the Electron bridge", () => {
    // Plain browser tab: no bridge, no attribute, default chrome CSS off.
    stop = watchDesktopChrome();
    expect(document.documentElement.hasAttribute("data-desktop")).toBe(false);

    window.lilos = fakeBridge().bridge;
    stop = watchDesktopChrome();
    expect(document.documentElement.hasAttribute("data-desktop")).toBe(true);
  });

  test("AC-4 data-fullscreen follows enter/leave events and the initial state", () => {
    const { bridge, emit } = fakeBridge();
    window.lilos = bridge;
    stop = watchDesktopChrome();
    expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(
      false,
    );
    emit(true);
    expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(true);
    emit(false);
    expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(
      false,
    );

    // A reload while the window is already full-screen starts in sync.
    window.lilos = fakeBridge(true).bridge;
    stop = watchDesktopChrome();
    expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(true);
  });
});

describe("desktop chrome stylesheet", () => {
  test("AC-1 the sidebar's first row reserves the traffic-light inset on desktop only", () => {
    // One shared reserve — no second magic number — set only outside full
    // screen (the OS hides the lights there).
    expect(css).toMatch(/--lilos-traffic-inset:\s*88px/);
    expect(css).toMatch(
      /html\[data-desktop\]:not\(\[data-fullscreen\]\)\s*\{[^}]*--lilos-traffic-inset/,
    );
    expect(css).toMatch(
      /html\[data-desktop\]:not\(\[data-fullscreen\]\)\s*\.lilos-v3\s*>\s*aside:first-child\s*>\s*div:first-child\s*\{[^}]*padding-left:\s*var\(--lilos-traffic-inset\)/,
    );
  });

  test("AC-3 header rows are drag regions with interactive children exempt", () => {
    expect(css).toMatch(/-webkit-app-region:\s*drag/);
    expect(css).toMatch(/-webkit-app-region:\s*no-drag/);
    // Every drag/no-drag rule stays scoped to the desktop window.
    const dragRules =
      css.match(/[^{}]+\{[^{}]*-webkit-app-region[^{}]*\}/g) ?? [];
    for (const rule of dragRules) expect(rule).toMatch(/data-desktop/);
  });

  test("AC-2 the document stays clear under Electron so the vibrancy shows", () => {
    expect(css).toMatch(
      /html\[data-desktop\]\s+body\s*\{[^}]*background:\s*transparent/,
    );
  });
});
