import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  freePort,
  openDefaultAgent,
  type Stack,
  skipFirstRun,
  startChat,
  v3Main,
} from "./helpers/stack";

/**
 * Evidence capture for #862 — the parked-thread thread list.
 *
 * Not part of the verify suite: every test here is skipped unless
 * `LILOS_EVIDENCE=1` is set. Run locally to regenerate the PR's shots:
 *
 *   LILOS_EVIDENCE=1 bunx playwright test e2e/evidence-862.spec.ts
 *
 * Output lands in test-results/evidence/862/. One shot per UI criterion:
 * the Pinned block, the row menu's park actions, the Snoozed shelf, and
 * the Settled shelf — all on the real Threads page against engine-fake.
 */

test.skip(
  process.env.LILOS_EVIDENCE !== "1",
  "evidence capture only — set LILOS_EVIDENCE=1",
);

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const OUT = path.join(here, "..", "test-results", "evidence", "862");

let stack: Stack;
let convId = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  stack = await bootStack("v3parkevid", {
    relay: 0,
    feed: 0,
    web: await freePort(),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => v3Main(page);
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
const row = (page: Page) => main(page).locator(`[data-thread-row="${convId}"]`);
const foldButton = (page: Page, fold: string) =>
  main(page).locator(`[data-fold="${fold}"] > button`);
const ensureOpen = async (page: Page, fold: string) => {
  const btn = foldButton(page, fold);
  if (
    (await btn.count()) &&
    (await btn.getAttribute("aria-expanded")) === "false"
  )
    await btn.click();
};
const menu = async (page: Page) => {
  await row(page).hover();
  await row(page)
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
};

test("park evidence: pinned, menu, snoozed, settled", async ({ page }) => {
  const agent = await openDefaultAgent(page, stack.webUrl);
  convId = await startChat(page, stack.webUrl, agent, "park evidence");
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(row(page)).toBeVisible({ timeout: 30_000 });

  /* The row menu is where every park action lives. */
  await menu(page);
  await page.getByRole("menuitem", { name: "Pin thread" }).hover();
  await shot(page, "thread-menu");
  await page.keyboard.press("Escape");

  /* Pinned: the thread row sits under its own block at the top. */
  await menu(page);
  await page.getByRole("menuitem", { name: "Pin thread" }).click();
  await expect(main(page).getByText("Pinned", { exact: true })).toBeVisible();
  await shot(page, "pinned");

  /* Snoozed: the folded shelf with the wake time on the row. */
  await menu(page);
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 h" }).click();
  await expect(foldButton(page, "snoozed")).toContainText("Snoozed");
  await ensureOpen(page, "snoozed");
  await shot(page, "snoozed-fold");

  /* Wake it, then settle: the Settled shelf with Un-settle on the menu. */
  await menu(page);
  await page.getByRole("menuitem", { name: "Wake now" }).click();
  await expect(foldButton(page, "snoozed")).toHaveCount(0);
  await menu(page);
  await page.getByRole("menuitem", { name: "Settle thread" }).click();
  await expect(foldButton(page, "settled")).toContainText("Settled (1)");
  await ensureOpen(page, "settled");
  await shot(page, "settled-shelf");
});
