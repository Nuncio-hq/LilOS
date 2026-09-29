import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { TRAFFIC_LIGHTS_END } from "../apps/desktop/src/window-chrome";
import { engineTag, expectNoEngineLeak } from "./engine-leak";
import { wport } from "./ports";

/**
 * Issue #232 — native macOS window chrome. Each acceptance criterion is a
 * named test. The Electron legs need a real NSWindow, so they run only on
 * macOS; the browser leg (AC-5: a normal tab is unchanged) runs everywhere.
 * Screenshots land in test-results/ac-232 as PR evidence.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");
const desktopDir = path.join(repo, "apps", "desktop");
const SHOTS = path.join(repo, "test-results", "ac-232");

const isMac = process.platform === "darwin";

interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
  stop: () => Promise<void>;
}

async function waitForHttp(url: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ok = await fetch(url)
      .then((r) => r.ok || r.status === 404)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function killProc(proc: ChildProcess): Promise<void> {
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

/** Boot `bun run dev` (relay + harness + vite dev) on offset ports. */
async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    await waitForHttp(`http://127.0.0.1:${ports.relay}/`);
    await waitForHttp(`http://127.0.0.1:${ports.feed}/`);
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    for (let i = 0; i < 300 && !relayToken; i++) {
      try {
        relayToken = readFileSync(tokenPath, "utf8").trim();
      } catch {}
      if (!relayToken) await new Promise((r) => setTimeout(r, 100));
    }
    if (!relayToken)
      throw new Error(`relay token never appeared at ${tokenPath}`);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    await killProc(proc);
    throw e;
  }
}

/** Build the Electron payload, then launch against the stack's web server. */
async function launchDesktop(stack: Stack): Promise<ElectronApplication> {
  const build = spawn("bun", ["scripts/dev.ts", "--payload-only"], {
    cwd: desktopDir,
    env: { ...process.env },
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    build.once("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`desktop build exit ${c}`)),
    );
  });
  const portOf = (ws: string) => new URL(ws).port;
  return _electron.launch({
    args: [desktopDir],
    env: {
      ...process.env,
      LILOS_RELAY_HOME: stack.home,
      LILOS_RELAY_PORT: portOf(stack.relayWs),
      LILOS_FEED_PORT: portOf(stack.feedWs),
      LILOS_WEB_URL: stack.webUrl,
    },
  });
}

const appRegion = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) =>
      getComputedStyle(el).getPropertyValue("-webkit-app-region"),
    );

const sidebarHeader = (page: Page) =>
  page.locator("aside.lilos-glass-side > div").first();

/** A fresh home gates the shell behind the first-run card — dismiss it so
 * the chrome underneath is clickable and screenshot-visible. */
async function dismissFirstRun(win: Page) {
  const skip = win.getByRole("button", { name: /set up later/i });
  if (
    await skip
      .first()
      .isVisible()
      .catch(() => false)
  )
    await skip.first().click();
  await expect(win.locator("[data-first-run]")).toHaveCount(0, {
    timeout: 10_000,
  });
}

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac232", {
    relay: wport(4680),
    feed: wport(4684),
    web: wport(5338),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

test("AC-1 no title bar strip; traffic lights inset into the sidebar header", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    await dismissFirstRun(win);
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
    await expect
      .poll(() => appRegion(win, "aside.lilos-glass-side > div"))
      .toBe("drag");
    const head = sidebarHeader(win);
    const pad = await head.evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(Number.parseFloat(pad)).toBeGreaterThanOrEqual(
      TRAFFIC_LIGHTS_END + 10,
    );
    const logoBox = await head.locator("div").first().boundingBox();
    if (!logoBox) throw new Error("company avatar has no box");
    expect(logoBox.x - TRAFFIC_LIGHTS_END).toBeGreaterThanOrEqual(10);
    await win.screenshot({ path: `${SHOTS}/ac-1-inset.png` });
  } finally {
    await app.close();
  }
});

test("AC-2 the window appearance follows the app theme", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    await expect(win.locator("[data-theme-toggle]")).toBeVisible({
      timeout: 60_000,
    });
    await dismissFirstRun(win);
    const source = () =>
      app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    // A dark app theme on a light OS must darken the vibrancy material too —
    // a light material under light text is unreadable.
    await win.locator('[data-theme-opt="dark"]').click();
    await expect.poll(source).toBe("dark");
    await expect(win.locator("html.dark")).toHaveCount(1);
    await win.locator('[data-theme-opt="system"]').click();
    await expect.poll(source).toBe("system");
  } finally {
    await app.close();
  }
});

test("AC-3 header strips drag the window, buttons inside still work", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    const dm = win.locator("aside").getByRole("button", { name: /default/i });
    await expect(dm).toBeVisible({ timeout: 60_000 });
    await dismissFirstRun(win);
    await dm.click();

    // Every panel header row is a drag region…
    await expect.poll(() => appRegion(win, "main header")).toBe("drag");
    await expect
      .poll(() => appRegion(win, "aside.lilos-glass-side > div"))
      .toBe("drag");
    // …but interactive children opt out.
    await expect
      .poll(() => appRegion(win, "main header button"))
      .toBe("no-drag");

    // Synthetic mouse events can't reach the native window-drag path — the
    // real drag/zoom evidence is the recorded manual pass — so here we prove
    // the OS-facing wiring: the element under empty header space IS the drag
    // region the OS hit-tests for dragging and double-click zoom.
    const box = await sidebarHeader(win).boundingBox();
    if (!box) throw new Error("sidebar header has no box");
    const hitRegion = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? getComputedStyle(el).getPropertyValue("-webkit-app-region")
          : "none";
      },
      [box.x + box.width - 20, box.y + box.height / 2] as const,
    );
    expect(hitRegion).toBe("drag");

    // A control inside the drag strip still clicks (profile button).
    await win
      .getByRole("button", { name: /profile/i })
      .first()
      .click();
    await expect(win.getByText(/personal|profile|about/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await win.screenshot({ path: `${SHOTS}/ac-3-drag.png` });
  } finally {
    await app.close();
  }
});

test("AC-4 full screen hides the lights and drops the sidebar inset", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    await dismissFirstRun(win);
    const padLeft = () =>
      sidebarHeader(win).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).paddingLeft),
      );
    const inset = await padLeft();
    expect(inset).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(true),
    );
    await expect
      .poll(() =>
        win.evaluate(() =>
          document.documentElement.hasAttribute("data-fullscreen"),
        ),
      )
      .toBe(true);
    // No lights means no reserved gap.
    await expect.poll(padLeft).toBeLessThan(30);
    await win.screenshot({ path: `${SHOTS}/ac-4-fullscreen.png` });

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(false),
    );
    await expect
      .poll(() =>
        win.evaluate(() =>
          document.documentElement.hasAttribute("data-fullscreen"),
        ),
      )
      .toBe(false);
    await expect.poll(padLeft).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_END + 10);
  } finally {
    await app.close();
  }
});

test("AC-5 the status window gets the same chrome", async () => {
  test.skip(!isMac, "native window chrome is a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    await dismissFirstRun(win);
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
    await statusWin.screenshot({ path: `${SHOTS}/ac-5-status.png` });
  } finally {
    await app.close();
  }
});

test("AC-5 a plain browser tab is unchanged", async ({ page }) => {
  await page.goto(`${stack.webUrl}/`);
  await expect(
    page.locator("aside").getByRole("button", { name: /default/i }),
  ).toBeVisible({ timeout: 30_000 });
  await dismissFirstRun(page);
  expect(
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-desktop"),
    ),
  ).toBe(false);
  // No traffic-light inset in a browser tab.
  const pad = await sidebarHeader(page).evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
  expect(pad).toBeLessThan(30);
  await page.screenshot({ path: `${SHOTS}/ac-5-browser.png` });
});
