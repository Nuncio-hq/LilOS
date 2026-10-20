import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { electronScreenshot, launchDesktop } from "./helpers/electron";
import { growDmThread } from "./helpers/relay-thread";
import {
  bootStack,
  panelFocusReady,
  pickPorts,
  type Stack,
  skipFirstRun,
  threadUrl,
} from "./helpers/stack";

/**
 * Issue #215 — the LilOS Browser in the Mac app (D-#215: main-process
 * WebContentsViews, renderers pure chrome).
 *
 *   AC-1 ⌘⇧B opens the docked panel AND the pop-out window; both render
 *        real Chromium pages (WebContentsView, persist:lilos-browser).
 *   AC-2 Tabs and partition sign-in state survive an app relaunch.
 *   AC-3 Downloads land on disk and list in the browser; ⌘F / zoom /
 *        print reach the page.
 *   AC-4 Nothing browser-shaped renders in the web build (D-#19).
 *
 * The native views paint above the window's DOM, so the spec verifies them
 * through the tab strip (real page titles arrive over `did-navigate`) and
 * captures page bitmaps via `webContents.capturePage` in the main process —
 * a window screenshot would show chrome only.
 * Menu accelerators are consumed by macOS, so the spec clicks menu items
 * and calls `window.lilos.browser.command` directly where a chord only
 * forwards a key.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-215");
const stateDir = path.join(tmpdir(), `lilos-ac215-${process.pid}`);
const downloadsDir = path.join(stateDir, "downloads");
const isMac = process.platform === "darwin";

/* A real page the view loads — data: passes the omnibox's scheme rule
   unchanged, needs no network, and carries its own probe text. */
const PAGE_URL =
  "data:text/html," +
  encodeURIComponent(
    `<title>AC-215 Page</title><body><h1>browserprobe215</h1>` +
      `<p>findme215</p></body>`,
  );
const PAGE_URL_2 =
  "data:text/html," +
  encodeURIComponent(`<title>Second Tab</title><body><p>second215</p></body>`);
const DOWNLOAD_URL =
  "data:text/plain;base64," +
  Buffer.from("ac215 download probe\n").toString("base64");

let stack: Stack;

/** The desktop app on the shared profile (`stateDir`: tabs and the browser
 *  partition persist across the relaunch), opened on `hash`. */
function launch(hash: string) {
  return launchDesktop(stack, {
    hash,
    stateDir,
    env: { LILOS_BROWSER_DOWNLOADS_DIR: downloadsDir },
  });
}

const clickMenuItem = (app: ElectronApplication, id: string) =>
  app.evaluate(
    ({ Menu }, menuId) =>
      Menu.getApplicationMenu()?.getMenuItemById(menuId)?.click(),
    id,
  );

/** The panel's page slot paints a real WebContentsView — capture its own
    bitmap, the only screenshot that shows the page instead of the chrome. */
async function captureView(app: ElectronApplication, file: string) {
  let png: string | null = null;
  await expect
    .poll(async () => {
      png = await app.evaluate(async ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (!w) return null;
        /* Older tabs stay attached but hidden — hidden views throw on
           capturePage, so try each child until one paints. */
        const kids = w.contentView.children as {
          webContents?: {
            getURL(): string;
            capturePage(): Promise<{ toPNG(): Buffer }>;
          };
        }[];
        for (const k of kids) {
          if (!k.webContents?.getURL()) continue;
          try {
            return (await k.webContents.capturePage())
              .toPNG()
              .toString("base64");
          } catch {
            /* hidden view */
          }
        }
        return null;
      });
      return png;
    })
    .toBeTruthy();
  if (!png) throw new Error("no visible WebContentsView painted");
  /* Another Playwright run's start wipes test-results/ mid-test. */
  mkdirSync(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(png, "base64"));
}

/** Newest WebContentsView webContents in the first window. */
const viewContents = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const kids = (w?.contentView.children ?? []) as {
      webContents?: { getURL(): string; getZoomFactor(): number };
    }[];
    const v = kids[kids.length - 1]?.webContents;
    return v ? { url: v.getURL(), zoom: v.getZoomFactor() } : null;
  });

const browserCmd = (win: Page, cmd: unknown) =>
  win.evaluate(
    (c) =>
      (
        window as Window & {
          lilos?: { browser: { command: (x: unknown) => unknown } };
        }
      ).lilos?.browser.command(c),
    cmd,
  );

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test.beforeAll(async () => {
  test.skip(!isMac, "the LilOS Browser is a macOS desktop feature");
  mkdirSync(SHOTS, { recursive: true });
  rmSync(stateDir, { recursive: true, force: true });
  stack = await bootStack("ac-215", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});

test.afterAll(async () => {
  await stack?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("AC-1/AC-3: panel renders real pages; pop-out window; find, zoom, print, downloads", async () => {
  const grown = await growDmThread(stack, ["thread for the browser spec"]);
  const hash = threadUrl(stack.webUrl, grown.conversationId);
  let { app, win } = await launch(hash);

  /* AC-1a: the View menu's LilOS Browser item (⌘⇧B's same path) opens the
     docked panel with its tab strip + omnibox. */
  await clickMenuItem(app, "browser");
  const dock = win.locator("[data-browser-dock]");
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await expect(dock.locator("[data-browser='panel']")).toBeVisible();
  const omnibox = dock.locator("[data-omnibox] input");
  await omnibox.fill(PAGE_URL);
  await omnibox.press("Enter");
  /* The strip shows the loaded page's own <title> — proof a real Chromium
     page rendered, since title comes from the view's webContents events. */
  await expect(
    dock.locator("[data-browser-tab]", { hasText: "AC-215 Page" }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await viewContents(app))?.url, { timeout: 15_000 })
    .toBe(PAGE_URL);
  await captureView(app, path.join(SHOTS, "ac1-panel-page.png"));
  await electronScreenshot(app, win, path.join(SHOTS, "ac1-panel.png"));

  /* A second tab keeps both tabs in the strip. */
  await dock.getByRole("button", { name: "New tab" }).first().click();
  const om2 = dock.locator("[data-omnibox] input");
  await om2.fill(PAGE_URL_2);
  await om2.press("Enter");
  await expect(
    dock.locator("[data-browser-tab]", { hasText: "Second Tab" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(dock.locator("[data-browser-tab]")).toHaveCount(2);

  /* AC-1b: pop-out is a real OS window loading the same chrome. */
  await dock.locator("[data-browser-mode-toggle]").click();
  let bw: Page | undefined;
  await expect
    .poll(async () => {
      for (const w of app.windows()) {
        if (await w.locator("[data-browser='window']").count()) bw = w;
      }
      return !!bw;
    })
    .toBe(true);
  if (!bw) throw new Error("pop-out browser window never appeared");
  await expect(bw.locator("[data-browser='window']")).toBeVisible();
  await electronScreenshot(app, bw, path.join(SHOTS, "ac1-popout-window.png"));
  await bw.locator("[data-browser-mode-toggle]").click(); // back to panel
  await expect(dock).toBeVisible({ timeout: 15_000 });

  /* AC-3 find: ⌘F opens the drawn find bar; typing runs findInPage on the
     view and the pushed count lands in the bar ("N of M"). */
  await dock.locator("[data-omnibox] input").focus({ timeout: 8_000 });
  await win.keyboard.press("Meta+f");
  const findBar = dock.locator("[data-find-bar]");
  await expect(findBar).toBeVisible({ timeout: 10_000 });
  await findBar.locator("input").fill("second215");
  await expect(findBar).toContainText("1 of 1", { timeout: 15_000 });

  /* AC-3 zoom: the command lands on the view's zoom factor and the pill. */
  await browserCmd(win, { op: "zoom", slotId: "panel", zoom: 1.5 });
  await expect
    .poll(async () => (await viewContents(app))?.zoom, { timeout: 10_000 })
    .toBeCloseTo(1.5);

  /* AC-3 print: the `print` op must reach the view's webContents — spy on
     the instance method first, then printToPDF proves the render path
     (the sheet itself is OS modal — untestable headless). */
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const kids = (w?.contentView.children ?? []) as {
      webContents?: { print(o: object): void };
    }[];
    const wc = kids.find((k) => k.webContents)?.webContents;
    if (!wc) return;
    (globalThis as Record<string, number>).__printCalls = 0;
    wc.print = () => {
      globalThis.__printCalls += 1;
    };
  });
  await browserCmd(win, { op: "print", slotId: "panel" });
  await expect
    .poll(async () =>
      app.evaluate(
        () => (globalThis as Record<string, number>).__printCalls ?? 0,
      ),
    )
    .toBe(1);
  const pdf = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const kids = (w?.contentView.children ?? []) as {
      webContents?: { printToPDF(o: object): Promise<Uint8Array> };
    }[];
    const v = kids.find((k) => k.webContents)?.webContents;
    return v ? (await v.printToPDF({})).length > 1000 : false;
  });
  expect(pdf).toBe(true);

  /* AC-3 download: downloadURL on the view fires the partition session's
     will-download → file lands in the downloads dir and lists in the
     browser's library. */
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows()[0];
    const kids = (w?.contentView.children ?? []) as {
      webContents?: { downloadURL(u: string): void };
    }[];
    const v = kids.find((k) => k.webContents);
    v?.webContents?.downloadURL(url);
  }, DOWNLOAD_URL);
  await expect
    .poll(
      async () => {
        const { readdirSync } = await import("node:fs");
        return existsSync(downloadsDir) && readdirSync(downloadsDir).length;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  await dock.getByRole("button", { name: "Downloads" }).click();
  await expect(
    dock.locator("[data-browser-library] [data-download]"),
  ).toBeVisible({ timeout: 10_000 });
  await electronScreenshot(
    app,
    win,
    path.join(SHOTS, "ac3-downloads-library.png"),
  );

  /* AC-2 seed: a sign-in cookie on the shared partition. The store flush
     is explicit because Playwright's close() may not take the graceful
     quit path that flushes buffered writes. */
  await app.evaluate(async ({ session }) => {
    const s = session.fromPartition("persist:lilos-browser");
    /* No expiry = session cookie, which Chromium never writes to disk; a
       real sign-in cookie always carries Max-Age/Expires. */
    await s.cookies.set({
      url: "https://ac215.example",
      name: "signin",
      value: "persisted",
      expirationDate: Math.floor(Date.now() / 1000) + 86_400,
    });
    await s.cookies.flushStore();
  });

  /* AC-2: quit + relaunch restores the tabs; the partition keeps the
     sign-in cookie. */
  await app.close();
  ({ app, win } = await launch(hash));
  const dock2 = win.locator("[data-browser-dock]");
  /* open:true restores automatically — clicking the menu item would only
     toggle it closed again. */
  await expect
    .poll(async () => dock2.isVisible().catch(() => false), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(dock2.locator("[data-browser-tab]")).toHaveCount(2, {
    timeout: 15_000,
  });
  await electronScreenshot(app, win, path.join(SHOTS, "ac2-restored.png"));
  const cookie = await app.evaluate(async ({ session }) =>
    session.fromPartition("persist:lilos-browser").cookies.get({
      url: "https://ac215.example",
      name: "signin",
    }),
  );
  expect(cookie[0]?.value).toBe("persisted");
  await app.close();
});

/** The session view's Workbench, open: a folderless DM session doesn't
 *  auto-open it, and v3 has no `?tab=` — the header's Workbench toggle is the
 *  way in. */
async function openWorkbench(win: Page) {
  await panelFocusReady(win);
  const toggle = win.getByTitle("Workbench", { exact: true });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  if (!(await win.locator("[data-wb-shell]:not(.hidden)").count()))
    await toggle.click();
  await expect(win.locator("[data-wb-shell]:not(.hidden)")).toBeVisible({
    timeout: 30_000,
  });
}

test("AC-2 thread: the Workbench Browser tab shows this thread's tabs", async () => {
  const grown = await growDmThread(stack, ["thread browser spec"]);
  /* `full=1` is the session view (chat beside the Workbench). */
  const { app, win } = await launch(
    threadUrl(stack.webUrl, grown.conversationId, true),
  );
  try {
    await openWorkbench(win);
    /* Session view + Workbench Browser tab — the same host, scoped to this
       thread. */
    const tab = win.locator("[data-wb-browser]").first();
    await expect(tab).toBeVisible({ timeout: 60_000 });
    await tab.click();
    await expect(win.locator("[data-browser='thread']")).toBeVisible();
    const om = win
      .locator("[data-browser='thread'] [data-omnibox] input")
      .first();
    await om.fill(PAGE_URL);
    await om.press("Enter");
    await expect(
      win.locator("[data-browser='thread'] [data-browser-tab]", {
        hasText: "AC-215 Page",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await electronScreenshot(
      app,
      win,
      path.join(SHOTS, "ac2-thread-browser.png"),
    );
  } finally {
    await app.close();
  }
});

test("AC-4: no browser control in the web build", async ({ page }) => {
  const grown = await growDmThread(stack, ["web build has no browser UI"]);
  await skipFirstRun(page);
  await page.goto(threadUrl(stack.webUrl, grown.conversationId, true));
  await openWorkbench(page);
  /* The Workbench is open and has its tabs, but a web build has no native
     page host — no Browser tab, no dock, no open control. */
  await expect(page.locator("[data-wb-tab]").first()).toBeVisible();
  await expect(page.locator("[data-browser-dock]")).toHaveCount(0);
  await expect(page.locator("[data-browser-open]")).toHaveCount(0);
  await expect(page.locator("[data-wb-browser]")).toHaveCount(0);
  await page.screenshot({
    path: path.join(SHOTS, "ac4-web-no-browser.png"),
    fullPage: true,
  });
});
