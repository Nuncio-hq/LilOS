import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { TRAFFIC_LIGHTS_END } from "../apps/desktop/src/window-chrome";
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
 * The v3 shell's chrome: the sidebar's first row is the lights' strip (it
 * drags and carries the inset — apps/web/src/index.css), the shell's top bar
 * (`.lilos-drag`, packages/ui/src/v3/v3-topbar.tsx) and an open thread's own
 * header drag the window, and every control inside them opts out. The
 * sidebar can hide (⌘\, #793), and while it does the top bar takes over the
 * strip under the lights and leaves room for them; a surface header never
 * sits there.
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

/** The sidebar's first row: where the traffic lights sit. */
const SIDEBAR_HEADER = ".lilos-v3 > aside:first-child > div:first-child";
const sidebarHeader = (page: Page) => page.locator(SIDEBAR_HEADER);
/** The shell's own top bar (empty while the sidebar is docked; the toggle,
    Search and the company while it is hidden) — a `.lilos-drag` strip in the
    column beside the sidebar, above
    the page and the side peek. */
const TOP_BAR = ".lilos-v3 > div > .lilos-drag";

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

/** The v3 shell is up: the sidebar lists the seeded agent. */
const shellReady = (win: Page) =>
  expect(v3Sidebar(win).getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 60_000,
  });

const isFullscreen = (win: Page) =>
  win.evaluate(() => document.documentElement.hasAttribute("data-fullscreen"));

const setFullScreen = (app: ElectronApplication, on: boolean) =>
  app.evaluate(({ BrowserWindow }, v) => {
    BrowserWindow.getAllWindows()[0].setFullScreen(v);
  }, on);

test("AC-1 no title bar strip; traffic lights inset into the sidebar header", async () => {
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
    const { winH, contentH } = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return {
        winH: w.getBounds().height,
        contentH: w.getContentBounds().height,
      };
    });
    expect(contentH).toBe(winH);

    // The sidebar header is a drag region and its content clears the lights
    // (inset x=16 + a ~52-62px cluster → TRAFFIC_LIGHTS_END ≈ 78 worst case),
    // with the ~10px gap macOS leaves before content.
    await expect.poll(() => appRegion(win, SIDEBAR_HEADER)).toBe("drag");
    const head = sidebarHeader(win);
    const pad = await head.evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(Number.parseFloat(pad)).toBeGreaterThanOrEqual(
      TRAFFIC_LIGHTS_END + 10,
    );
    const logoBox = await head.locator("span").first().boundingBox();
    if (!logoBox) throw new Error("company avatar has no box");
    expect(logoBox.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
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

test("AC-3 header strips drag the window, buttons inside still work", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch(threadUrl(stack.webUrl, conversationId));
  try {
    await shellReady(win);
    await panelFocusReady(win);

    // Every header row is a drag region: the sidebar's lights row and the
    // shell's top bar. (The open thread's header is the top of its scrolling
    // conversation, not a strip — nothing there to drag by.)
    await expect.poll(() => appRegion(win, SIDEBAR_HEADER)).toBe("drag");
    await expect.poll(() => appRegion(win, TOP_BAR)).toBe("drag");
    // …but interactive children opt out (the sidebar's hide toggle).
    await expect
      .poll(() => appRegion(win, `${SIDEBAR_HEADER} button`))
      .toBe("no-drag");

    // Synthetic mouse events can't reach the native window-drag path — the
    // real drag/zoom evidence is the recorded manual pass — so here we prove
    // the OS-facing wiring: the element under empty header space IS the drag
    // region the OS hit-tests for dragging and double-click zoom.
    const regionAt = (x: number, y: number) =>
      win.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          return el
            ? getComputedStyle(el).getPropertyValue("-webkit-app-region")
            : "none";
        },
        [x, y] as const,
      );
    // The lights' strip, left of the company name, is empty header space.
    const box = await sidebarHeader(win).boundingBox();
    if (!box) throw new Error("sidebar header has no box");
    expect(await regionAt(box.x + 4, box.y + box.height / 2)).toBe("drag");
    // The top bar docked is empty (the page names itself, Search is the
    // sidebar's): all of it is window-draggable space.
    const bar = await win.locator(TOP_BAR).boundingBox();
    if (!bar) throw new Error("top bar has no box");
    expect(await regionAt(bar.x + bar.width / 2, bar.y + bar.height / 2)).toBe(
      "drag",
    );

    // A control inside the drag strip still clicks: the sidebar's hide
    // toggle hides it…
    await sidebarHeader(win)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();
    // …and the top bar, now carrying its own controls, keeps them clickable
    // inside the drag strip: Search opens the palette.
    await expect
      .poll(() => appRegion(win, `${TOP_BAR} button`))
      .toBe("no-drag");
    await win.getByRole("button", { name: "Search", exact: true }).click();
    await expect(win.getByRole("dialog", { name: "Search" })).toBeVisible({
      timeout: 10_000,
    });
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-3-drag.png` });
  } finally {
    await app.close();
  }
});

test("AC-4 full screen hides the lights and drops the sidebar inset", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    const padLeft = () =>
      sidebarHeader(win).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).paddingLeft),
      );
    const inset = await padLeft();
    expect(inset).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);

    await setFullScreen(app, true);
    await expect.poll(() => isFullscreen(win)).toBe(true);
    // No lights means no reserved gap.
    await expect.poll(padLeft).toBeLessThan(30);
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-4-fullscreen.png` });

    // The hidden sidebar hands the lights' reserve to the top bar, and
    // full screen drops it there too.
    await sidebarHeader(win)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();
    const barPad = () =>
      win
        .locator(TOP_BAR)
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
    await expect.poll(barPad).toBeLessThan(30);

    await setFullScreen(app, false);
    await expect.poll(() => isFullscreen(win)).toBe(false);
    await expect.poll(barPad).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);
    await win.getByRole("button", { name: "Show sidebar" }).click();
    await expect.poll(padLeft).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);
  } finally {
    await app.close();
  }
});

test("AC-7 a hidden sidebar: the top bar clears the lights and still drags; popped out, the sidebar keeps the inset", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const { app, win } = await launch();
  try {
    await shellReady(win);
    await sidebarHeader(win)
      .getByRole("button", { name: "Hide sidebar" })
      .click();
    await expect(v3Sidebar(win)).toBeHidden();

    // The bar is the strip under the lights now: as tall as the lights' row,
    // draggable, and its first control is clear of them plus the macOS gap.
    await expect.poll(() => appRegion(win, TOP_BAR)).toBe("drag");
    await expect
      .poll(() => appRegion(win, `${TOP_BAR} button`))
      .toBe("no-drag");
    const bar = await win.locator(TOP_BAR).boundingBox();
    const show = await win
      .getByRole("button", { name: "Show sidebar" })
      .boundingBox();
    if (!bar || !show) throw new Error("hidden top bar has no box");
    expect(bar.y).toBe(0);
    expect(bar.height).toBeGreaterThanOrEqual(56);
    expect(show.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    // Empty bar space (right of the breadcrumb) drags the window.
    const region = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? getComputedStyle(el).getPropertyValue("-webkit-app-region")
          : "none";
      },
      [bar.x + bar.width - 40, bar.height / 2] as const,
    );
    expect(region).toBe("drag");

    // Hovering the left edge pops the sidebar out over the page; its first
    // row keeps the lights' reserve and its toggle stays clickable.
    await win.mouse.move(400, 300);
    await win.mouse.move(2, 300);
    await expect(v3Sidebar(win)).toBeVisible();
    await expect
      .poll(() =>
        sidebarHeader(win).evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).paddingLeft),
        ),
      )
      .toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);
    await expect.poll(() => appRegion(win, SIDEBAR_HEADER)).toBe("drag");
    await expect
      .poll(() => appRegion(win, `${SIDEBAR_HEADER} button`))
      .toBe("no-drag");
    await waitForNativeFrame(app, win);
    await win.screenshot({ path: `${SHOTS}/ac-7-popped.png` });
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
    expect(box.height).toBeGreaterThanOrEqual(56);
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

test("#295 the session view's header clears the lights strip (the sidebar keeps it); Back is live", async () => {
  /* v3 never puts a surface header under the lights, unlike the old Focus
     view: the sidebar's first row owns the strip at every width and in the
     session view alike (hidden, the top bar does — AC-7). What #295 guarded —
     the leftmost control of the open surface is not under the lights, the
     strip still drags, full screen drops the reserve, Back works — is
     asserted on the session view (`full=1`, chat beside the Workbench). */
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

    /* The thread draws no strip of its own (its header scrolls with the
       conversation): the open surface's top is the side peek's header, under
       the shell's drag bar. */
    const header = v3Peek(win);
    await expect(header).toBeVisible({ timeout: 30_000 });
    const padLeft = () =>
      sidebarHeader(win).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).paddingLeft),
      );

    // The strips still drag the window…
    await expect.poll(() => appRegion(win, TOP_BAR)).toBe("drag");
    await expect.poll(() => appRegion(win, SIDEBAR_HEADER)).toBe("drag");
    // …the lights' reserve lives on the sidebar header, which sits left of
    // the surface, so the surface's first control clears the lights plus the
    // ~10px macOS gap.
    await expect.poll(padLeft).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);
    const controlBox = await header.getByRole("button").first().boundingBox();
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

    // Full screen hides the lights — no leftover gap; leaving restores it.
    await setFullScreen(app, true);
    await expect.poll(() => isFullscreen(win)).toBe(true);
    await expect.poll(padLeft).toBeLessThan(30);
    await setFullScreen(app, false);
    await expect.poll(() => isFullscreen(win)).toBe(false);
    await expect.poll(padLeft).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);

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
  const pad = await sidebarHeader(page).evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
  expect(pad).toBeLessThan(30);
  // …and no drag regions: the header rows are plain page chrome there.
  expect(await appRegion(page, SIDEBAR_HEADER)).not.toBe("drag");
  expect(await appRegion(page, TOP_BAR)).not.toBe("drag");
  await page.screenshot({ path: `${SHOTS}/ac-5-browser.png` });
});
