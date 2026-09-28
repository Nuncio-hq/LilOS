import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * DM page layout. With no session open, the employee feed must fill the
 * window: Oscar saw an empty column on the right of the desktop app before
 * any thread or workbench was opened. Layout needs a real browser, so this is
 * an e2e over the live web app (engine-fake).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

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
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

async function bootStack(
  tag: string,
  ports: { relay: number; feed: number; web: number },
  extraEnv: Record<string, string> = {},
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    return {
      home,
      webUrl,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      stop: () => killProc(proc),
    };
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
}

const PROMPT = "What does the replay contract carry?"; // engine-fake script

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  // First run shows the welcome overlay; its button opens the DM.
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/* The DM page's middle pane is EmployeeHome's <main>. With no session open
   there is no thread panel, so it must reach the window's right edge — no
   reserved-but-empty column (Oscar's report on the desktop app). */
const mainPane = (page: Page) => page.locator("main").first();

async function rightGap(page: Page): Promise<number> {
  const box = await mainPane(page).boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  if (!box) throw new Error("DM main pane not laid out");
  return Math.round(width - (box.x + box.width));
}

test("DM page: with no session open the feed fills the window (no empty right column)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const stack = await bootStack("dmfill", {
    relay: 4630,
    feed: 4631,
    web: 5220,
  });
  try {
    await dmDefault(page, stack.webUrl);
    await expect(mainPane(page)).toBeVisible();
    expect(await rightGap(page), "empty page, no session").toBeLessThanOrEqual(
      1,
    );

    // With a session open, the thread panel takes the right column.
    const box = page.locator("textarea").last();
    await box.fill(PROMPT);
    await box.press("Enter");
    await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
    // The thread header shows the session's auto title (placeholder →
    // engine-written, #137) — the prompt's own words land there first.
    const panel = page
      .locator("main")
      .getByText(
        /What does the replay contract carry|What Does The Replay Contract Carry/,
      )
      .first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    expect(await rightGap(page)).toBeGreaterThan(300);

    // Back to the employee (session closed): the feed fills the window again.
    await page
      .locator("aside")
      .getByRole("button", { name: /default/i })
      .click();
    await expect(page).toHaveURL(/\/dm\/[^/]+$/);
    expect(await rightGap(page), "session closed").toBeLessThanOrEqual(1);
  } finally {
    await stack.stop();
  }
});
