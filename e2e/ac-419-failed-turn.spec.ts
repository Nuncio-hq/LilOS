import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #419 — a failed turn (model error, Mac slept, engine restart) stops
 * reading `done`: the turn carries a `Failed · <error>` chip, its thread card
 * on Threads reads Failed, and the turn's Retry re-sends the last user
 * message in the same session. engine-fake's `fail …` prompt is the
 * deterministic failure: ~2s of reasoning, then turn.completed{error}.
 *
 * v3 dropped the old session-row alert card (the red reason line with its own
 * Retry): a failed thread's card on Threads shows the Failed pill and Open,
 * nothing more, so that card and its Retry have no leg here any more.
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

/** The thread composer in the peek — the new-chat draft has another box. */
const threadBox = (page: Page) =>
  v3Peek(page).locator("[data-thread-panel] textarea");

const send = async (page: Page, text: string) => {
  const box = threadBox(page);
  await box.fill(text);
  await box.press("Enter");
};

/** The thread's card on the Threads board (its title is the first message,
    which the engine re-cases: "Say hi" → "Say Hi"). */
const threadCard = (page: Page, title: string) =>
  page.locator("main").getByRole("button", { name: new RegExp(title, "i") });

/* Rows mount under `lilos-rise` (0.5s opacity+blur): a reload's screenshot
   mid-rise reads as a dim smear — wait out the animation on its own end
   state (filter: none) before shooting. */
const settled = (page: Page, sel: string) =>
  expect(page.locator(sel).last()).toHaveCSS("filter", /^(none|blur\(0px\))$/);

test("AC-1/AC-3 a turn.completed.error shows the failure chip on the turn and the Failed pill on its thread card", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  // A clean session first: the pill is failure-only (AC-3), not permanent.
  await startChat(
    page,
    stack.webUrl,
    { id: "default", name: "Hermes" },
    "Say hi",
  );
  await expect(page.locator("[data-agentturn]").last()).toContainText(
    /answer|envelope|Done/i,
    { timeout: 60_000 },
  );
  await expect(page.locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(threadCard(page, "Say hi")).toBeVisible({ timeout: 30_000 });
  await expect(threadCard(page, "Say hi")).not.toContainText("Failed");

  // The scripted failure: reasoning streams, then the turn ends with an error.
  await threadCard(page, "Say hi").click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
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
  // #585: the harness's "Error: …" system note is dropped — the turn's own
  // failure chip already says the same thing (deduped, not stacked).
  await expect(
    page.locator("[data-sysnote]", {
      hasText: /engine-fake: scripted failure/,
    }),
  ).toHaveCount(0);
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-1-failed-turn-light.png` });

  // The thread's card on the Threads board reads Failed.
  await expect(threadCard(page, "Say hi")).toContainText("Failed", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-419-1-thread-card-light.png` });

  // AC-3 dark: the same chip in the persisted dark theme.
  await page.evaluate(() => localStorage.setItem("lilos-theme", "dark"));
  await page.reload();
  await expect(
    page.locator("[data-agentturn]").last().locator("[data-turn-failed]"),
  ).toBeVisible({ timeout: 30_000 });
  await settled(page, "[data-agentturn]");
  await page.screenshot({ path: `${SHOTS}/ac-419-3-failed-turn-dark.png` });
  await expect(threadCard(page, "Say hi")).toContainText("Failed");
  await page.screenshot({ path: `${SHOTS}/ac-419-3-thread-card-dark.png` });
  await page.evaluate(() => localStorage.setItem("lilos-theme", "light"));
});

test("AC-2 the turn's hover Retry re-sends the last user message in the same session", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await threadCard(page, "Say hi").click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
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
