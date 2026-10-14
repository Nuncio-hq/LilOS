import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #563 — a turn that finishes (or fails) while its thread is unopened
 * dots the session card and the employee's sidebar row; opening the thread
 * stamps the relay's read watermark, clearing the dot on every client at
 * once (the watermark is server-side — a second browser clears live off
 * `conversation.updated`).
 *
 * Serial legs on one stack: the dot is created on client A, seen on client
 * B, cleared by A's open.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-563");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("read-dot", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
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

const employeeIdFromUrl = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

/** Default's sidebar row and the dot inside it. */
const defaultRow = (page: Page) =>
  page.locator("aside").getByRole("button", { name: /default/i });
const sideDot = (page: Page) => defaultRow(page).locator("[data-badge-unseen]");

test("finish while unopened dots card + employee; opening clears on both clients", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  /* A second browser = the other device: it must see the dot appear and
     clear live, without touching the thread itself. */
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();

  /* Client A: send, then immediately leave the thread — the turn finishes
     while the DM feed (not the thread) is on screen. */
  await dmDefault(page);
  await send(page, "Say hello then list files");
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  const empId = employeeIdFromUrl(page);
  await page.goto(`${stack.webUrl}/dm/${empId}`);
  await expect(page).toHaveURL(new RegExp(`/dm/${empId}$`));

  /* The finish lands unopened: the dot shows on Default's sidebar row on
     BOTH clients — its appearance is the completion signal. Client B
     stays on Home, never touching Default's channel: its dot must arrive
     over the boot-wide DM subscriptions, not the open-DM feed. */
  await pageB.goto(`${stack.webUrl}/`);
  await expect(
    pageB.locator("aside").getByRole("button", { name: /default/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(sideDot(page)).toBeVisible({ timeout: 90_000 });
  await expect(sideDot(pageB)).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: `${SHOTS}/dot-sidebar.png` });

  /* The session card in the feed carries its own dot. */
  const cardDot = page.locator("[data-thread-unseen]");
  await expect(cardDot).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dot-card.png` });

  /* Opening the thread stamps the watermark: the dot clears on A's card
     and sidebar AND on B's sidebar — no reload, no second mark. */
  await cardDot.click();
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  await expect(sideDot(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(sideDot(pageB)).toHaveCount(0, { timeout: 30_000 });

  /* …and the clear is the stored watermark, not a UI state: back on the
     feed the card reads clean, and a reload keeps it that way. */
  await page.goto(`${stack.webUrl}/dm/${empId}`);
  await expect(page.locator("[data-thread-unseen]")).toHaveCount(0);
  await page.reload();
  await expect(sideDot(page)).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/cleared.png` });

  await ctxB.close();
  await page.close();
});
