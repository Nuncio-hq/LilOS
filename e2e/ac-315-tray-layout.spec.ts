import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { wport } from "./ports";

/**
 * #315 tray geometry: the waiting tray must reserve its own height — it can
 * never paint over the message list. Coordinator fix on PR #358: with an
 * approval pending AND a waiting mid-turn send, the tray sliced through the
 * approval card's body and hid the Approve/Deny row. This spec parks a turn
 * on an approval, parks a send in the tray, then measures the real boxes at
 * 1288x700, 900 and 1440 — the approval card's bottom edge must land at or
 * above the tray's top edge, and the card must stay answerable.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const webDir = path.join(repo, "apps", "web");

interface Stack {
  home: string;
  webUrl: string;
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
      LILOS_USER_NAME: "Oscar",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    await waitForHttp(webUrl);
    return { home, webUrl, stop: () => killProc(proc) };
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
}

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]').first();
const tray = (page: Page) => page.locator("[data-queued]").first();

/* The invariant must hold at every sampled instant — not just after the
   layout settles: a boundingBox read anywhere has to see the card fully
   above the tray. */
async function cardAboveTray(page: Page, width: number) {
  const cardBox = await openCard(page).boundingBox();
  const trayBox = await tray(page).boundingBox();
  if (!cardBox || !trayBox) {
    throw new Error(
      `missing boxes at ${width}: card=${!!cardBox} tray=${!!trayBox}`,
    );
  }
  const cardBottom = cardBox.y + cardBox.height;
  // 1px subpixel slack; the regression was a ~90px overlap.
  expect(
    cardBottom,
    `at ${width}px wide the approval card bottom (${cardBottom}) must end at or above the tray top (${trayBox.y})`,
  ).toBeLessThanOrEqual(trayBox.y + 1);
}

test("tray reserves its height: the approval card stays answerable with a waiting send (1288 / 900 / 1440)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await bootStack("traygeo", {
    relay: wport(4643),
    feed: wport(4647),
    web: wport(5241),
  });
  try {
    await page.setViewportSize({ width: 1288, height: 700 });
    await dmDefault(page, stack.webUrl);
    // Edit-ask prompt: the turn parks on the approval card and stays live.
    await send(page, "Add a release note to the readme");
    await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
    await expect(openCard(page)).toBeVisible({ timeout: 30_000 });
    // A mid-turn send waits in the tray — the state that must not cover the card.
    await send(page, "first waiting nudge");
    await expect(tray(page)).toBeVisible();
    await cardAboveTray(page, 1288);

    await page.setViewportSize({ width: 1440, height: 700 });
    await cardAboveTray(page, 1440);

    await page.setViewportSize({ width: 900, height: 700 });
    await cardAboveTray(page, 900);

    // …and the card stays clickable at the tightest width — "Allow once"
    // resolves the ask (the 900px shot hid the button row entirely).
    await openCard(page)
      .getByRole("button", { name: /Allow once/i })
      .click();
    const askId = await openCard(page).getAttribute("data-ask-id");
    if (askId) {
      await expect
        .poll(
          () =>
            page
              .locator(`[data-ask-id="${askId}"]`)
              .evaluateAll((els) =>
                els.some(
                  (el) => el.getAttribute("data-ask-state") === "open",
                ),
              ),
          { timeout: 15_000 },
        )
        .toBe(false);
    }
  } finally {
    await stack.stop();
  }
});
