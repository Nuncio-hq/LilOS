import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #583 — the app says what it's waiting for, real app (apps/web over
 * relay + harness on engine-fake). AC-1 while a turn waits on Oscar the
 * composer says so ("waiting for your approval…"), never "working"; AC-2
 * every DM row carries its state in words (running / needs you / failed /
 * stopped); AC-3 a thread with a live background job says so on its row and
 * in the thread panel. Issue #586 AC-1 rides along: the placeholder names
 * the employee, never an engine id.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-583");

/** Land on the DM home composer of the seeded employee. */
async function openApp(stack: Stack, page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
  await expect(
    page.locator("aside").getByRole("button", { name: /Default/ }),
  ).toBeVisible({ timeout: 30_000 });
}

const empId = (page: Page) =>
  decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);

/** Back to the DM home rows (sends land in Focus). */
async function dmHome(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/dm/${empId(page)}`);
  await expect(page.locator("[data-session]").first()).toBeVisible({
    timeout: 30_000,
  });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const openCard = (page: Page) =>
  page.locator('[data-ask-id][data-ask-state="open"]');
const newestRow = (page: Page) => page.locator("[data-session]").first();

test.describe.configure({ mode: "serial" });
test.use({ video: "on" });

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac583", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test("AC-1+#586 the composer names the employee, then says it's waiting for Oscar's approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(stack, page);

  /* #586 AC-1: idle placeholder is "Reply to Default…" — never an engine
     ref like `20261006_…` or `emp_…`. */
  const box = page.locator("textarea").last();
  await expect(box).toHaveAttribute("placeholder", /Reply to Default/);
  await expect(box).not.toHaveAttribute("placeholder", /emp_|2026\d{4}/);

  /* AC-1: a turn parked on an approval — the composer says it waits on
     Oscar, not that it's "working". */
  await send(page, "Add a footer to the page");
  await expect(openCard(page).first()).toBeVisible({ timeout: 60_000 });
  await expect(box).toHaveAttribute(
    "placeholder",
    /Default is waiting for your approval/,
  );
  await expect(box).not.toHaveAttribute("placeholder", /working/i);
  await page.screenshot({ path: `${SHOTS}/ac-1-waiting-composer.png` });

  /* Answer Once so the turn finishes and the row goes idle again. */
  await openCard(page)
    .first()
    .getByRole("button", { name: "Once", exact: true })
    .click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test("AC-1 a waiting plan says the same", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(stack, page);
  await send(page, "plan: propose a release checklist");
  /* The plan ask opens a card of its own; the composer tells Oscar he's
     holding the turn up. */
  const box = page.locator("textarea").last();
  await expect(box).toHaveAttribute(
    "placeholder",
    /waiting for your approval/,
    { timeout: 60_000 },
  );
  await page.screenshot({ path: `${SHOTS}/ac-1-waiting-plan.png` });
  /* Approve the plan so the turn closes before the next test. */
  const approve = page.getByRole("button", { name: /^Approve$/ });
  if (await approve.isVisible().catch(() => false)) await approve.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
});

test("AC-2 a DM row waiting on an approval says \"needs you\"", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(stack, page);
  await send(page, "Change the header color");
  await expect(openCard(page).first()).toBeVisible({ timeout: 60_000 });
  await dmHome(stack, page);
  /* The row itself says needs-you while Oscar hasn't answered. */
  await expect(
    newestRow(page).locator('[data-thread-state="needs you"]'),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-needs-you.png` });
  /* Deny → turn ends; the state word clears with the open card. */
  await openCard(page)
    .first()
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    newestRow(page).locator('[data-thread-state="needs you"]'),
  ).toHaveCount(0);
});

test("AC-2 a running turn and a failed turn each say so", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(stack, page);
  await send(page, "slow: keep the pace for a while");
  await expect(page.locator("[data-agentturn]").last()).toBeVisible({
    timeout: 30_000,
  });
  await dmHome(stack, page);
  await expect(
    newestRow(page).locator('[data-thread-state="running"]'),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-running.png` });
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 120_000,
  });

  /* A turn that dies on an error reads "failed" on its row. */
  await send(page, "fail on purpose");
  await dmHome(stack, page);
  await expect(
    newestRow(page).locator('[data-thread-state="failed"]'),
  ).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-failed.png` });
});

test("AC-2 a stopped turn says \"stopped\"", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(stack, page);
  await send(page, "slow: hold this turn while I stop it");
  const stop = page.getByRole("button", { name: /stop/i }).first();
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
  await dmHome(stack, page);
  await expect(
    newestRow(page).locator('[data-thread-state="stopped"]'),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-row-stopped.png` });
});

test("AC-2 the state words read in dark mode too", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("lilos-theme", "dark"));
  await openApp(stack, page);
  await send(page, "fail again for the dark check");
  await dmHome(stack, page);
  await expect(
    newestRow(page).locator('[data-thread-state="failed"]'),
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: `${SHOTS}/ac-2-row-failed-dark.png` });
});

test("AC-3 a live background job says so on the row and in the thread", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(stack, page);
  await send(page, "start a dev server");
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 90_000,
  });
  /* The dev-server job stays running past the turn — the row says so… */
  await dmHome(stack, page);
  await expect(newestRow(page).locator("[data-bg-jobs]")).toContainText(
    /in background/,
    { timeout: 30_000 },
  );
  /* …and so does the open thread's header. */
  await newestRow(page).locator("button").last().click();
  await expect(
    page.locator("[data-bg-jobs]").filter({ hasText: /running in background/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-background-job.png` });
});
