import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #419 — a failed turn (model error, Mac slept, engine restart) stops
 * reading `done`: the turn carries a `Failed · <error>` chip, its DM session
 * row carries the failure card with Retry, and Retry re-sends the last user
 * message in the same session. engine-fake's `fail …` prompt is the
 * deterministic failure: ~2s of reasoning, then turn.completed{error}.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");

const SHOTS = path.join(repo, "test-results", "ac-419");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac419", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

/** Land on Default's DM without a first-run detour. */
async function dmDefault(page: Page) {
  await page.goto(`${stack.webUrl}/`);
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
}

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const dmHome = async (page: Page) => {
  const empId = decodeURIComponent(page.url().split("/dm/")[1].split("/")[0]);
  await page.goto(`${stack.webUrl}/dm/${empId}`);
};

/* Rows mount under `lilos-rise` (0.5s opacity+blur): a reload's screenshot
   mid-rise reads as a dim smear — wait out the animation on its own end
   state (filter: none) before shooting. */
const settled = (page: Page, sel: string) =>
  expect(page.locator(sel).last()).toHaveCSS("filter", /^(none|blur\(0px\))$/);

/** The first session row → its "N replies" pill opens the thread. */
const openSession = async (page: Page) => {
  await page
    .locator("[data-session]")
    .first()
    .getByRole("button", { name: /repl/i })
    .click();
};

test("AC-1/AC-3 a turn.completed.error shows the failure chip on the turn and the alert card on the session row", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await dmDefault(page);
  // A clean session first: the card is failure-only (AC-3), not permanent.
  await send(page, "Say hi");
  await expect(page.locator("[data-agentturn]").last()).toContainText(
    /answer|envelope|Done/i,
    { timeout: 60_000 },
  );
  await dmHome(page);
  await expect(page.locator("[data-session]").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-session-alert]")).toHaveCount(0);

  // The scripted failure: reasoning streams, then the turn ends with an error.
  await openSession(page);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  await send(page, "fail the deploy script");
  const failed = page.locator("[data-agentturn]").last();
  await expect(failed.locator("[data-turn-failed]")).toBeVisible({
    timeout: 60_000,
  });
  await expect(failed.locator("[data-turn-failed]")).toContainText(
    /Failed · engine-fake: scripted failure/,
  );
  // The turn ended — the settled footer exists (hover surface for Retry).
  await expect(failed.locator("[data-turnsettled]")).toHaveCount(1);
  // The harness's in-thread note carries the error, not a manual "Retry."
  await expect(
    page.getByText(/Error: engine-fake: scripted failure/),
  ).toBeVisible();
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-1-failed-turn-light.png` });

  // The session row card: red model-error alert with its own Retry.
  await dmHome(page);
  const alert = page.locator("[data-session-alert]");
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText(/engine-fake: scripted failure/);
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
  await settled(page, "[data-session] .lilos-rise");
  await page.screenshot({ path: `${SHOTS}/ac-419-1-session-alert-light.png` });

  // AC-3 dark: the same card + chip in the persisted dark theme.
  await page.evaluate(() => localStorage.setItem("lilos-theme", "dark"));
  await page.reload();
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await settled(page, "[data-session] .lilos-rise");
  await page.screenshot({ path: `${SHOTS}/ac-419-3-session-alert-dark.png` });
  await openSession(page);
  await expect(
    page.locator("[data-agentturn]").last().locator("[data-turn-failed]"),
  ).toBeVisible({ timeout: 30_000 });
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-3-failed-turn-dark.png` });
  await page.evaluate(() => localStorage.setItem("lilos-theme", "light"));
});

test("AC-2 the turn's hover Retry re-sends the last user message in the same session", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await dmDefault(page);
  await openSession(page);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  const convUrl = page.url();
  // Count turns only once the thread has painted — otherwise `before`
  // races to 0 and the retry's index points at the old turn.
  await expect(page.locator("[data-agentturn]").first()).toBeVisible({
    timeout: 30_000,
  });
  const before = await page.locator("[data-agentturn]").count();

  // Retry is the hover action on the last turn (prototype shape, AC-3).
  const lastTurn = page.locator("[data-agentturn]").last();
  await lastTurn.hover();
  await lastTurn.getByRole("button", { name: "Retry" }).click();

  // Same session (URL unchanged), a fresh turn streaming its reasoning
  // under the failed one — and its error echoes the re-sent text, proving
  // the LAST user message went out again verbatim.
  await expect(page).toHaveURL(convUrl);
  const retryTurn = page.locator("[data-agentturn]").nth(before);
  await expect(retryTurn).toBeVisible({ timeout: 30_000 });
  await expect(retryTurn).toContainText(/Reading the workspace/, {
    timeout: 60_000,
  });
  await expect(retryTurn.locator("[data-turn-failed]")).toContainText(
    /Failed · engine-fake: scripted failure for "fail the deploy script"/,
    { timeout: 60_000 },
  );
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-2-hover-retry.png` });
});

test("AC-2 the session card's Retry does the same re-send from the DM home", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await dmDefault(page);
  const alert = page.locator("[data-session-alert]");
  await expect(alert).toBeVisible({ timeout: 30_000 });
  const convsBefore = await page.locator("[data-session]").count();
  expect(convsBefore).toBeGreaterThan(0);

  await alert.getByRole("button", { name: "Retry" }).click();

  // Same session retried: no new session row appears; opening it shows the
  // re-sent message and its fresh (again-failing) turn.
  await expect(page.locator("[data-session]")).toHaveCount(convsBefore);
  await openSession(page);
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+/, { timeout: 30_000 });
  await expect(
    page.locator("[data-agentturn]").last().locator("[data-turn-failed]"),
  ).toContainText(
    /Failed · engine-fake: scripted failure for "fail the deploy script"/,
    { timeout: 60_000 },
  );
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-2-card-retry.png` });
});
