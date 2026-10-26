import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHT_SIZE,
  TRAFFIC_LIGHTS_END,
} from "../apps/desktop/src/window-chrome";
import { launchDesktop } from "./helpers/electron";
import { growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  panelFocusReady,
  panelOutOfFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  threadUrl,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Issue #232 — native macOS window chrome. Each acceptance criterion is a
 * named test. The Electron legs need a real NSWindow, so they run only on
 * macOS; the browser leg (AC-5: a normal tab is unchanged) runs everywhere.
 * Screenshots land in test-results/ac-232 as PR evidence.
 *
 * The v3 shell's chrome (#797): ONE toolbar row, the first row of each
 * column — the sidebar's segment (the lights sit in it, then the sidebar
 * toggle), the page's, and the side peek's (packages/ui/src/v3/v3-topbar.tsx).
 * Every segment is `.lilos-drag` and drags the window, every control inside
 * opts out, and the segment at the window's left edge carries the lights'
 * inset (apps/web/src/index.css). The sidebar can hide (⌘\, #793), and while
 * it does the page's segment (or the peek's, once widened over it) leads the
 * row and takes the inset; no surface header ever sits under the lights.
 * ac-797 covers the row's layout; this file the native window around it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-232");

const isMac = process.platform === "darwin";

/** The app window on this stack, past first run, opened on `hash`. */
const launch = (hash?: string) => launchDesktop(stack, { hash });

const appRegion = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) =>
      getComputedStyle(el).getPropertyValue("-webkit-app-region"),
    );

/** The toolbar row's segments, one per column (D-#232, #797). */
const SIDEBAR_BAR = "aside[data-sidebar] > [data-toolbar]";
const PAGE_BAR = "[data-v3-topbar]";
const PEEK_BAR = 'aside[aria-label="Opened record"] > [data-toolbar]';
/** Where the lights end plus the ~10px macOS leaves before content. */
const CLEAR_OF_LIGHTS = TRAFFIC_LIGHTS_END + 10;

const padLeft = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));

/** The drag region the OS hit-tests at a point: the element under it. */
const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el
        ? getComputedStyle(el).getPropertyValue("-webkit-app-region")
        : "none";
    },
    [x, y] as const,
  );

const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
};

/**
 * Wait until a native window is actually producing pixels before capturing
 * it (#365): `Page.captureScreenshot` fails fast with "Unable to capture
 * screenshot" when the window's compositor surface has never had a frame —
 * a fresh second window can sit in that state for seconds when the OS is
 * still presenting it (occluded at birth, GPU/display contention). The
 * `capturePage` probe reads the same compositor surface: non-empty means a
 * real frame is readable. The double-rAF then proves the compositor is
 * still issuing frames, so the capture's fresh-frame request completes
 * instead of hanging — both are rendered-pixel signals, not retries.
 */
async function waitForNativeFrame(app: ElectronApplication, win: Page) {
  const url = win.url();
  await expect
    .poll(() =>
      app
        .evaluate(async ({ BrowserWindow }, u) => {
          const w = BrowserWindow.getAllWindows().find((x) =>
            x.webContents.getURL().startsWith(u),
          );
          if (!w || w.isDestroyed() || w.webContents.isDestroyed())
            return false;
          const image = await w.capturePage();
          return !image.isEmpty();
        }, url)
        .catch(() => false),
    )
    .toBe(true);
  await win.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

let stack: Stack;
let conversationId = "";
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac232", await pickPorts());
  /* The thread the session-view and drag legs open on. */
  conversationId = (await growDmThread(stack, ["chrome check"])).conversationId;
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/** The v3 shell is up: its Threads nav is drawn (D-#836 paused the sidebar's
    agent row, the old signal). */
const shellReady = (win: Page) =>
  expect(v3Sidebar(win).getByRole("button", { name: /^Threads/ })).toBeVisible({
    timeout: 60_000,
  });

const isFullscreen = (win: Page) =>
  win.evaluate(() => document.documentElement.hasAttribute("data-fullscreen"));

const setFullScreen = (app: ElectronApplication, on: boolean) =>
  app.evaluate(({ BrowserWindow }, v) => {
    BrowserWindow.getAllWindows()[0].setFullScreen(v);
  }, on);

test("AC-1 no title bar strip; the traffic lights centred in the toolbar row, its content clear of them", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    await expect
      .poll(() =>
        win.evaluate(() =>
          document.documentElement.hasAttribute("data-desktop"),
        ),
      )
      .toBe(true);

    // A hidden title bar means the content reaches the window's top edge.
    const { winH, contentH, lights } = await app.evaluate(
      ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return {
          winH: w.getBounds().height,
          contentH: w.getContentBounds().height,
          lights: w.getWindowButtonPosition(),
        };
      },
    );
    expect(contentH).toBe(winH);

    // The sidebar's segment is the toolbar row at the window's top: a drag
    // region TOOLBAR_HEIGHT (52) tall, and the lights are centred in it — the
    // cluster's top-left is `lights`, its discs TRAFFIC_LIGHT_SIZE tall.
    await expect.poll(() => appRegion(win, SIDEBAR_BAR)).toBe("drag");
    const bar = await boxOf(win, SIDEBAR_BAR);
    expect([bar.y, bar.height]).toEqual([0, TOOLBAR_HEIGHT]);
    expect((lights?.y ?? 0) + TRAFFIC_LIGHT_SIZE / 2).toBe(bar.height / 2);

    // Its content clears the lights (inset x=16 + a ~52-62px cluster →
    // TRAFFIC_LIGHTS_END ≈ 78 worst case) plus the ~10px gap macOS leaves:
    // the toggle is the first thing in it, a 28px button centred on the row.
    expect(await padLeft(win, SIDEBAR_BAR)).toBeGreaterThanOrEqual(
      CLEAR_OF_LIGHTS,
    );
    const toggle = await boxOf(win, `${SIDEBAR_BAR} button`);
    expect(toggle.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    expect([toggle.width, toggle.height]).toEqual([28, 28]);
    expect(toggle.y + toggle.height / 2).toBe(bar.height / 2);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-1-inset.png` });
  } finally {
    await app.close();
  }
});

test("AC-2 the window appearance follows the app theme", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    const source = () =>
      app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    // A dark app theme on a light OS must darken the vibrancy material too —
    // a light material under light text is unreadable. v3's sidebar has one
    // toggle ("Dark mode" / "Light mode", named for where it goes next), so
    // reach the dark side from whichever label the OS appearance shows.
    const side = v3Sidebar(win);
    if (await side.getByRole("button", { name: "Light mode" }).count())
      await side.getByRole("button", { name: "Light mode" }).click();
    await side.getByRole("button", { name: "Dark mode" }).click();
    await expect.poll(source).toBe("dark");
    await expect(win.locator("html.dark")).toHaveCount(1);
    await side.getByRole("button", { name: "Light mode" }).click();
    await expect.poll(source).toBe("light");
    await expect(win.locator("html.dark")).toHaveCount(0);
    /* v3 has no "System" control: the stored preference is the way back to
       following the OS, and the shell must push it on load just the same. */
    await win.evaluate(() => localStorage.setItem("lilos-theme", "system"));
    await win.reload();
    await shellReady(win);
    await expect.poll(source).toBe("system");
  } finally {
    await app.close();
  }
});

test("AC-3 the toolbar's segments drag the window, buttons inside still work", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch(threadUrl(stack.webUrl, conversationId));
  try {
    await shellReady(win);
    await panelFocusReady(win);

    // Every segment of the row is a drag region: the sidebar's, the page's
    // and the side peek's — with the controls inside them exempt.
    for (const bar of [SIDEBAR_BAR, PAGE_BAR, PEEK_BAR]) {
      await expect.poll(() => appRegion(win, bar)).toBe("drag");
    }
    await expect
      .poll(() => appRegion(win, `${SIDEBAR_BAR} button`))
      .toBe("no-drag");
    await expect
      .poll(() => appRegion(win, `${PEEK_BAR} button`))
      .toBe("no-drag");

    // Synthetic mouse events can't reach the native window-drag path — the
    // real drag/zoom evidence is the recorded manual pass — so here we prove
    // the OS-facing wiring: the element under empty toolbar space IS the drag
    // region the OS hit-tests for dragging and double-click zoom.
    // The lights' strip, left of the toggle, is empty space.
    const side = await boxOf(win, SIDEBAR_BAR);
    expect(await regionAt(win, side.x + 4, side.y + side.height / 2)).toBe(
      "drag",
    );
    // The page's segment is empty (the page names itself, Search is the
    // sidebar's row): all of it is window-draggable space.
    const page = await boxOf(win, PAGE_BAR);
    expect(
      await regionAt(win, page.x + page.width / 2, page.y + page.height / 2),
    ).toBe("drag");
    // The peek's segment: its padding, left of Back, is the strip itself.
    const peek = await boxOf(win, PEEK_BAR);
    expect(await regionAt(win, peek.x + 4, peek.y + peek.height / 2)).toBe(
      "drag",
    );

    // A control inside the drag strip still clicks: the sidebar's toggle
    // hides it…
    await win
      .locator(SIDEBAR_BAR)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();
    // …and the page's segment, now carrying the toggle and Search, keeps
    // them clickable inside the drag strip: Search opens the palette.
    await expect
      .poll(() => appRegion(win, `${PAGE_BAR} button`))
      .toBe("no-drag");
    await win
      .locator(PAGE_BAR)
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(win.getByRole("dialog", { name: "Search" })).toBeVisible({
      timeout: 10_000,
    });
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-3-drag.png` });
  } finally {
    await app.close();
  }
});

test("AC-4 full screen hides the lights and drops the toolbar's inset", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    const sidebarPad = () => padLeft(win, SIDEBAR_BAR);
    expect(await sidebarPad()).toBeGreaterThanOrEqual(CLEAR_OF_LIGHTS);

    await setFullScreen(app, true);
    await expect.poll(() => isFullscreen(win)).toBe(true);
    // No lights means no reserved gap.
    await expect.poll(sidebarPad).toBeLessThan(30);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-4-fullscreen.png` });

    // The hidden sidebar hands the lights' reserve to the page's segment,
    // and full screen drops it there too.
    await win
      .locator(SIDEBAR_BAR)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();
    const barPad = () => padLeft(win, PAGE_BAR);
    await expect.poll(barPad).toBeLessThan(30);

    await setFullScreen(app, false);
    await expect.poll(() => isFullscreen(win)).toBe(false);
    await expect.poll(barPad).toBeGreaterThanOrEqual(CLEAR_OF_LIGHTS);
    await win
      .locator(PAGE_BAR)
      .getByRole("button", { name: "Show sidebar" })
      .click();
    await expect.poll(sidebarPad).toBeGreaterThanOrEqual(CLEAR_OF_LIGHTS);
  } finally {
    await app.close();
  }
});

test("AC-7 a hidden sidebar: the page's segment leads the row and the toggle stays right after the lights; popped out, the sidebar keeps the inset", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    const dockedToggle = await boxOf(win, `${SIDEBAR_BAR} button`);
    await win
      .locator(SIDEBAR_BAR)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();

    // The page's segment is the row under the lights now: at the window's
    // top, as tall as the row, draggable, and its first control — the
    // toggle — is clear of them plus the macOS gap.
    await expect.poll(() => appRegion(win, PAGE_BAR)).toBe("drag");
    await expect
      .poll(() => appRegion(win, `${PAGE_BAR} button`))
      .toBe("no-drag");
    const bar = await boxOf(win, PAGE_BAR);
    expect([bar.x, bar.y, bar.height]).toEqual([0, 0, TOOLBAR_HEIGHT]);
    const show = await boxOf(win, `${PAGE_BAR} button`);
    expect(show.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    // The toggle did not move: docked or hidden, it is right after the
    // lights, in the same place.
    expect([show.x, show.y]).toEqual([dockedToggle.x, dockedToggle.y]);
    // Empty space in the segment drags the window.
    expect(await regionAt(win, bar.x + bar.width - 40, bar.height / 2)).toBe(
      "drag",
    );

    // Hovering the left edge pops the sidebar out over the page: its own top
    // row keeps the lights' reserve and its toggle stays clickable, in the
    // same place. It is first in the document but floats over the page's
    // segment, which hands the strip over so the OS (later regions win) does
    // not take the toggle back as drag space.
    await win.mouse.move(400, 300);
    await win.mouse.move(2, 300);
    await expect(v3Sidebar(win)).toBeVisible();
    await expect
      .poll(() => padLeft(win, SIDEBAR_BAR))
      .toBeGreaterThanOrEqual(CLEAR_OF_LIGHTS);
    await expect.poll(() => appRegion(win, SIDEBAR_BAR)).toBe("drag");
    await expect
      .poll(() => appRegion(win, `${SIDEBAR_BAR} button`))
      .toBe("no-drag");
    await expect.poll(() => appRegion(win, PAGE_BAR)).toBe("no-drag");
    await expect
      .poll(async () => {
        const keep = await boxOf(win, `${SIDEBAR_BAR} button`);
        return [keep.x, keep.y];
      })
      .toEqual([dockedToggle.x, dockedToggle.y]);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-7-popped.png` });

    // Tucked again, the page's segment drags once more.
    await win.mouse.move(700, 300);
    await expect(v3Sidebar(win)).toBeHidden({ timeout: 5_000 });
    await expect.poll(() => appRegion(win, PAGE_BAR)).toBe("drag");
  } finally {
    await app.close();
  }
});

test("AC-8 View → Toggle Sidebar (⌘\\) hides and shows the sidebar", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  // The menu accelerator consumes the chord before the page sees it, so the
  // shell hears it as a request from the app: drive the menu item itself.
  const { app, win } = await launch();
  try {
    await shellReady(win);
    const toggle = () =>
      app.evaluate(({ Menu }) => {
        const view = Menu.getApplicationMenu()?.items.find(
          (i) => i.label === "View",
        );
        view?.submenu?.items.find((i) => i.label === "Toggle Sidebar")?.click();
      });
    await toggle();
    await expect(v3Sidebar(win)).toBeHidden();
    await toggle();
    await expect(v3Sidebar(win)).toBeVisible();
  } finally {
    await app.close();
  }
});

test("AC-6 first run (Welcome) has a strip the window drags by, under the lights", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  // Welcome has no sidebar, so nothing else owns the lights' row: without its
  // own strip the window could not be moved while setting up.
  const { app, win } = await launch("#?page=welcome");
  try {
    await expect(
      win.getByRole("heading", { name: "Welcome to LilOS" }),
    ).toBeVisible({ timeout: 60_000 });
    const strip = ".lilos-v3 > .lilos-drag";
    await expect.poll(() => appRegion(win, strip)).toBe("drag");
    // It is as tall as the sidebar's lights row, so the lights sit inside it
    // and nothing of the page does.
    const box = await win.locator(strip).boundingBox();
    const title = await win
      .getByRole("heading", { name: "Welcome to LilOS" })
      .boundingBox();
    if (!box || !title) throw new Error("Welcome has no strip or title");
    expect(box.y).toBe(0);
    expect(box.height).toBeGreaterThanOrEqual(TOOLBAR_HEIGHT);
    expect(title.y).toBeGreaterThanOrEqual(box.y + box.height);
    // The page's own controls are never under the drag region.
    await expect
      .poll(() => appRegion(win, "button:has-text('Next')"))
      .not.toBe("drag");
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-6-welcome-drag.png` });
  } finally {
    await app.close();
  }
});

test("AC-5 the status window gets the same chrome", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    await win.evaluate(() =>
      (
        window as unknown as { lilos?: { openStatus?: () => void } }
      ).lilos?.openStatus?.(),
    );
    await expect.poll(() => app.windows().length).toBe(2);
    const statusWin = app.windows().find((w) => w.url().startsWith("file://"));
    if (!statusWin) throw new Error("status window did not open");
    const { winH, contentH } = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().startsWith("file://"),
      );
      if (!w) return { winH: -1, contentH: -2 };
      return {
        winH: w.getBounds().height,
        contentH: w.getContentBounds().height,
      };
    });
    expect(contentH).toBe(winH);
    // The status page keeps a drag strip under the inset lights.
    await expect.poll(() => appRegion(statusWin, "#drag-strip")).toBe("drag");
    await waitForNativeFrame(app, statusWin);
    await statusWin.screenshot({ path: `${SHOTS}/ac-5-status.png` });
  } finally {
    await app.close();
  }
});

test("#295 the widened session's toolbar clears the lights (docked: the sidebar's segment; hidden: its own lead); Back is live", async () => {
  /* v3 never puts a surface header under the lights, unlike the old Focus
     view: the toolbar row's leftmost segment owns the strip at every width
     and in the session view alike — the sidebar's while it is docked, the
     peek's (spanning the window) once the sidebar hides under a widened
     thread (#797). What #295 guarded — the leftmost control of the open
     surface is not under the lights, the strip still drags, full screen
     drops the reserve, Back works — is asserted on the session view
     (`full=1`, chat beside the Workbench). */
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch(
    threadUrl(stack.webUrl, conversationId, true),
  );
  try {
    await shellReady(win);
    // The repro's window: 1288 wide.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1288, 860),
    );
    await panelFocusReady(win);

    // The thread draws no strip of its own (its header scrolls with the
    // conversation): the open surface's top is the side peek's segment.
    const peek = v3Peek(win);
    await expect(peek).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => appRegion(win, PEEK_BAR)).toBe("drag");
    await expect.poll(() => appRegion(win, SIDEBAR_BAR)).toBe("drag");

    // Docked, the sidebar's segment carries the lights' reserve and sits left
    // of the surface, so the surface's first control is clear of them too.
    expect(await padLeft(win, SIDEBAR_BAR)).toBeGreaterThanOrEqual(
      CLEAR_OF_LIGHTS,
    );
    const controlBox = await peek.getByRole("button").first().boundingBox();
    if (!controlBox) throw new Error("header control has no box");
    expect(controlBox.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/295-focus-light.png` });

    // Dark AC shot: v3's one sidebar toggle ("Dark mode" / "Light mode").
    const side = v3Sidebar(win);
    if (await side.getByRole("button", { name: "Light mode" }).count())
      await side.getByRole("button", { name: "Light mode" }).click();
    await side.getByRole("button", { name: "Dark mode" }).click();
    await expect(win.locator("html.dark")).toHaveCount(1);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/295-focus-dark.png` });

    // Hide the sidebar under the widened thread: the peek's segment spans the
    // window and leads with the toggle and Search, clear of the lights, then
    // Back — one set of them on the screen, not the page's too.
    await win
      .locator(SIDEBAR_BAR)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(side).toBeHidden();
    const bar = await boxOf(win, PEEK_BAR);
    expect([bar.x, bar.width]).toEqual([0, 1288]);
    expect(await padLeft(win, PEEK_BAR)).toBeGreaterThanOrEqual(
      CLEAR_OF_LIGHTS,
    );
    const show = await boxOf(win, `${PEEK_BAR} button`);
    expect(show.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    await expect(win.getByRole("button", { name: "Show sidebar" })).toHaveCount(
      1,
    );
    const back = await peek.getByTitle("Back one step").boundingBox();
    if (!back) throw new Error("Back has no box");
    expect(back.x).toBeGreaterThan(show.x + show.width);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/295-focus-hidden.png` });

    // Full screen hides the lights — no leftover gap; leaving restores it.
    await setFullScreen(app, true);
    await expect.poll(() => isFullscreen(win)).toBe(true);
    await expect.poll(() => padLeft(win, PEEK_BAR)).toBeLessThan(30);
    await setFullScreen(app, false);
    await expect.poll(() => isFullscreen(win)).toBe(false);
    await expect
      .poll(() => padLeft(win, PEEK_BAR))
      .toBeGreaterThanOrEqual(CLEAR_OF_LIGHTS);

    // Back is a live control, not dead space: it steps out of the session
    // view to the thread beside Threads (`full=1` leaves the URL).
    await panelOutOfFocus(win);
    await expect(win).toHaveURL(/[?&]open=thread:[^&]+/, { timeout: 30_000 });
  } finally {
    await app.close();
  }
});

test("AC-5 a plain browser tab is unchanged", async ({ page }) => {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await shellReady(page);
  expect(
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-desktop"),
    ),
  ).toBe(false);
  // No traffic-light inset in a browser tab…
  expect(await padLeft(page, SIDEBAR_BAR)).toBeLessThan(30);
  // …and no drag regions: the toolbar's segments are plain page chrome there.
  expect(await appRegion(page, SIDEBAR_BAR)).not.toBe("drag");
  expect(await appRegion(page, PAGE_BAR)).not.toBe("drag");
  await page.screenshot({ path: `${SHOTS}/ac-5-browser.png` });
});
