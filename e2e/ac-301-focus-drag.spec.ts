import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * Issue #301 — the Focus expand/collapse button lands dead on first click:
 * the thread panel ⇄ Focus swap mounts a fresh `.lilos-drag` header with the
 * toggle at the same spot the cursor is already over, and the OS-side
 * draggable-region map isn't recomputed until a pointer event forces it —
 * the click is swallowed as a window drag.
 *
 * What this spec can and cannot prove: Playwright's `page.mouse.click`
 * dispatches synthetic events that never reach the native NSView hit-test,
 * so no synthetic click can *fail* the way Oscar's real one did. What it
 * CAN assert end to end is the fix's mechanism: a MutationObserver watching
 * `style` mutations on `.lilos-drag` elements proves `watchDragRegions()`
 * actually re-pushed the region map after the swap (the flip is a real
 * two-frame DOM diff), and `elementFromPoint` + computed `-webkit-app-region`
 * prove the control sits in a no-drag rect in CSS terms. The real-click
 * repro before/after the fix is the screencapture evidence on the PR.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const desktopDir = path.join(repo, "apps", "desktop");
const SHOTS = path.join(repo, "test-results", "ac-301");

const isMac = process.platform === "darwin";

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

const FOCUS_URL = /\/dm\/[^/]+\/[^/]+\/focus$/;
const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac301", {
    relay: wport(4700),
    feed: wport(4778),
    web: wport(5379),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

test("#301 Focus toggle stays clickable across the panel ⇄ Focus header swap", async () => {
  test.skip(!isMac, "native drag regions are a macOS leg");
  test.setTimeout(180_000);
  const app = await launchDesktop(stack);
  try {
    const win = await app.firstWindow();
    await expect(
      win.locator("aside").getByRole("button", { name: /default/i }),
    ).toBeVisible({ timeout: 60_000 });
    await dismissFirstRun(win);
    await win
      .locator("aside")
      .getByRole("button", { name: /default/i })
      .click();
    await expect(win).toHaveURL(/\/dm\//, { timeout: 30_000 });

    // A send lands in Focus (#149); back out to the panel so the Expand
    // button sits at the spot the next click will land.
    const box = win.locator("textarea").last();
    await box.fill("check in");
    await box.press("Enter");
    await expect(win).toHaveURL(FOCUS_URL, { timeout: 30_000 });
    await win.getByTitle("Exit focus", { exact: true }).click();
    await expect(win).toHaveURL(PANEL_URL, { timeout: 30_000 });

    const expand = win
      .locator("[data-thread-panel]")
      .getByTitle("Focus", { exact: true });
    await expect(expand).toBeVisible({ timeout: 30_000 });

    // Count every inline-style mutation the region watcher performs on a
    // .lilos-drag element — proof the OS map was re-pushed after a swap,
    // installed BEFORE the click that mounts Focus.
    await win.evaluate(() => {
      (window as unknown as { __regionFlips: number }).__regionFlips = 0;
      const mo = new MutationObserver((muts) => {
        for (const m of muts)
          if (m.target instanceof Element && m.target.closest(".lilos-drag"))
            (window as unknown as { __regionFlips: number }).__regionFlips += 1;
      });
      mo.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    });

    // The control must sit in a no-drag rect inside its drag strip.
    await expect
      .poll(() => appRegion(win, "[data-thread-panel] .lilos-drag"))
      .toBe("drag");
    await expect
      .poll(() => appRegion(win, 'button[title="Focus"]'))
      .toBe("no-drag");
    const box1 = await expand.boundingBox();
    if (!box1) throw new Error("expand button has no box");
    const cx = box1.x + box1.width / 2;
    const cy = box1.y + box1.height / 2;
    const hit = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Focus"]') ? "button" : "other";
      },
      [cx, cy] as const,
    );
    expect(hit).toBe("button");

    // Synthetic click #1 at that point, no prior mouse-out — mounts Focus.
    await win.mouse.click(cx, cy);
    await expect(win).toHaveURL(FOCUS_URL, { timeout: 30_000 });
    const collapse = win.getByTitle("Exit focus", { exact: true });
    await expect(collapse).toBeVisible({ timeout: 30_000 });

    // The watcher's recompute ran against the newly mounted header…
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as { __regionFlips: number }).__regionFlips,
        ),
      )
      .toBeGreaterThan(0);
    // …and the fresh button is again a no-drag rect at the same spot.
    await expect.poll(() => appRegion(win, "main > header")).toBe("drag");
    await expect
      .poll(() => appRegion(win, 'button[title="Exit focus"]'))
      .toBe("no-drag");
    const box2 = await collapse.boundingBox();
    if (!box2) throw new Error("exit-focus button has no box");
    const hit2 = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('button[title="Exit focus"]') ? "button" : "other";
      },
      [box2.x + box2.width / 2, box2.y + box2.height / 2] as const,
    );
    expect(hit2).toBe("button");
    await win.screenshot({ path: `${SHOTS}/301-focus-swapped.png` });

    // Click #2, back to the panel — same coordinates, still no mouse-out.
    await win.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await expect(win).toHaveURL(PANEL_URL, { timeout: 30_000 });
    await expect(expand).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
