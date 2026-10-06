import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile, expectSettled } from "./helpers/approvals";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #308 — a reply must anchor under ITS own prompt row, never below a
 * newer user message; an engine-initiated leg mints its own card, claims its
 * delivered post, and stays above anything posted while it ran. The spec boots
 * the real slice (relay + harness + engine-fake + vite dev) with the `steer`
 * capability hidden so mid-run sends take the queue-drain path — the exact
 * production shape where a late reply used to tail-append under a newer row.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-308");

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await bootStack("order", await pickPorts(), {
    LILOS_USER_NAME: "Oscar",
    /* No steer → mid-run sends queue and drain as ref'd turns (AC-1's
         bug shape). The one prompt needing a running window carries
         `slowleg:` (#574) instead of slowing every turn suite-wide. */
    LILOS_HIDE_CAPS: "steer",
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

const mainText = async (page: Page) =>
  page.locator("[data-thread]").innerText();

test("AC-2/AC-3 an engine leg keeps its own card above newer rows; its post is claimed, not duplicated", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);
  /* `slowleg:` paces only the armed leg (default 300 ms — the pace the
     suite-wide tick used to give EVERY turn) so "meanwhile" still lands
     mid-leg; the arming turn and the queue drains run at engine tick. */
  await send(page, "slowleg: leg:ZEBRA report delivered");
  /* #577: a send lands on the thread panel; [data-thread] asserts live in
     Focus — step in via the panel's ↗. */
  await panelIntoFocus(page);
  // The prompt turn answers first; the leg opens after it settles.
  const turns = page.locator("[data-agentturn]");
  await expect(turns.first()).toContainText("I'll report back", {
    timeout: 120_000,
  });
  // AC-2: the engine-initiated leg is its own card, flagged Agent-initiated.
  await expect(turns).toHaveCount(2, { timeout: 60_000 });
  const leg = turns.nth(1);
  await expect(leg.getByText("Agent-initiated")).toBeVisible({
    timeout: 30_000,
  });
  // AC-3 composer truth: agent's own work → Enter queues (no steer cap).
  await expect(page.locator("textarea").last()).toHaveAttribute(
    "placeholder",
    /working on its own/,
    { timeout: 15_000 },
  );
  // A message sent while the leg runs renders BELOW the live leg card.
  await send(page, "meanwhile zebra note");
  await expect(
    page.locator("[data-thread]").getByText("meanwhile zebra note").first(),
  ).toBeVisible({ timeout: 15_000 });
  const during = await mainText(page);
  expect(during.indexOf("Agent-initiated")).toBeGreaterThanOrEqual(0);
  expect(during.indexOf("Agent-initiated")).toBeLessThan(
    during.indexOf("meanwhile zebra note"),
  );
  await page.screenshot({ path: `${SHOTS}/ac-3-leg-live.png` });
  // The leg's delivered answer lands ONCE — inside its card, not as a second
  // bare employee row.
  await expect(leg).toContainText("ZEBRA report delivered", {
    timeout: 60_000,
  });
  /* Exact match: the user's own "leg:…" prompt row also carries the phrase —
     a second exact occurrence can only be an unclaimed bare employee row. */
  await expect(
    page.getByText("ZEBRA report delivered", { exact: true }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-3-leg-done.png` });
  // The queued "meanwhile" message drains as its own turn anchored under it
  // (the follow-up script folds its prompt, capitalized, into the answer).
  await expect(turns).toHaveCount(3, { timeout: 120_000 });
  await expect(turns.last()).toContainText("Meanwhile zebra note", {
    timeout: 120_000,
  });
  const settled = await mainText(page);
  expect(settled.indexOf("meanwhile zebra note")).toBeLessThan(
    settled.indexOf("Meanwhile zebra note"),
  );
  /* Post-drain, the leg's post is still claimed exactly once — the bare
     duplicate must not reappear once a newer claimed row exists. */
  await expect(
    page.getByText("ZEBRA report delivered", { exact: true }),
  ).toHaveCount(1);
});

test("AC-1/AC-5 queued replies anchor under their own prompt — even after reload", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await dmDefault(page);
  // Hold the session open on an approval so both sends queue behind it.
  await send(page, "Add a release note to the readme");
  // #577: a send lands on the thread panel; [data-thread] lives in Focus.
  await panelIntoFocus(page);
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 120_000,
  });
  await send(page, "first queued zebra");
  // A second Enter while the first post is in-flight is dropped — wait for
  // each row before sending the next. #315: a waiting send lives in the
  // tray above the composer, not as a thread row.
  await expect(
    page.locator("[data-queued]").getByText("first queued zebra").first(),
  ).toBeVisible({ timeout: 15_000 });
  await send(page, "second queued apple");
  await expect(
    page.locator("[data-queued]").getByText("second queued apple").first(),
  ).toBeVisible({ timeout: 15_000 });
  const turns = page.locator("[data-agentturn]");
  /* The edit script raises several gated asks seconds apart — answer each
     as it opens until the first turn actually settles; exiting on a quiet
     window parks the turn mid-approvals and the queued sends never drain
     (#451). */
  await allowAllWhile(page, expectSettled(turns.first()));
  await expect(page.getByText("Allowed once by Oscar").first()).toBeVisible({
    timeout: 30_000,
  });
  // Turn 1 finishes first — the queue drains only on turn.completed.
  await expect(turns.first()).toContainText(/Done on|Review it/, {
    timeout: 120_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-turn1-done.png` });
  // Both queued prompts drain as their own turns in order — three cards total.
  await expect(turns).toHaveCount(3, { timeout: 240_000 });
  /* The follow-up script folds each prompt, capitalized, into its card —
     that distinguishes each drained answer from its own user row. */
  await expect(turns.last()).toContainText("Second queued apple", {
    timeout: 120_000,
  });
  await expect(turns.nth(1)).toContainText("First queued zebra", {
    timeout: 120_000,
  });
  const assertOrder = async () => {
    const text = await mainText(page);
    const a = text.indexOf("first queued zebra");
    const aAnswer = text.indexOf("First queued zebra");
    const b = text.indexOf("second queued apple");
    const bAnswer = text.indexOf("Second queued apple");
    expect(a).toBeGreaterThanOrEqual(0);
    // A's drained reply anchors under A — a newer user row never renders
    // above an older message's answer.
    expect(a).toBeLessThan(aAnswer);
    expect(aAnswer).toBeLessThan(b);
    expect(b).toBeLessThan(bAnswer);
  };
  await assertOrder();
  await page.screenshot({ path: `${SHOTS}/ac-1-queued-order.png` });
  // AC-5: reload — replayed frames produce the same order.
  await page.reload();
  await expect(page.locator("textarea").last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-agentturn]")).toHaveCount(3, {
    timeout: 60_000,
  });
  await assertOrder();
  await page.screenshot({ path: `${SHOTS}/ac-5-reload-order.png` });
});
