import { expect, type Page, test } from "@playwright/test";

/* Issue #9 AC-2: an engine that does NOT declare the steer capability (prototype: `?steer=off`,
   which stands in for `describe().capabilities` missing "steer"). Mid-turn typing must queue in a
   tray that auto-sends when the turn ends — and no steer affordance may render anywhere. The
   steer-on counterpart lives in prototype-flows.spec.ts. Console errors must be 0. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function sendDM(page: Page, text: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New thread with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

test("AC-2 steer absent: mid-turn typing queues, no steer affordance", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/?steer=off");
  await sendDM(page, "Check the relay reconnect plan");
  // The running composer's copy says "queues", never "steers" — and no steer
  // chips/rows may render for the whole turn.
  const box = page.getByPlaceholder(/is working\. Enter queues it/);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-steerstate="pending"]')).toHaveCount(0);
  await box.fill("also check the replay window");
  await box.press("Enter");
  // The send went to the queued tray, not into the turn.
  const tray = page.locator("[data-queued]");
  await expect(tray).toBeVisible();
  await expect(tray).toHaveAttribute("data-queued-mode", "next");
  await expect(tray).toContainText("Runs when this turn ends");
  await expect(tray).toContainText("also check the replay window");
  await expect(page.locator("[data-steerstate]")).toHaveCount(0);
  // When the turn ends the queued message sends itself: the tray empties and the
  // text lands as Oscar's own message in the thread (then a new turn runs).
  await expect(tray).toHaveCount(0, { timeout: 60_000 });
  await expect(
    page.getByText("also check the replay window").first(),
  ).toBeVisible();
  // Still no steer affordance — not even landed rows (none were ever sent).
  await expect(page.locator("[data-steerstate]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("AC-2 steer absent: a queued message can be removed before it sends", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/?steer=off");
  await sendDM(page, "Summarise the harness reconnect notes");
  const box = page.getByPlaceholder(/is working\. Enter queues it/);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill("actually never mind that");
  await box.press("Enter");
  const tray = page.locator("[data-queued]");
  await expect(tray).toBeVisible();
  await page.locator("[data-queued-remove]").first().click();
  await expect(tray).toHaveCount(0);
  // The removed item never appears as a message, even once the turn has ended
  // (had it not been removed it would have auto-sent as the next prompt).
  await expect(
    page.getByPlaceholder(/Reply to Builder/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText("actually never mind that", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
