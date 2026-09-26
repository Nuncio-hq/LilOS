import { expect, type Page, test } from "@playwright/test";

/* Issue #12 flow coverage for the extracted @lilos/ui components (text/role assertions only — no pixel
   snapshots, so this stays stable on CI Linux). Proves the extraction did not break behavior:
   DM send → streamed reply · channel @mention → thread + reply · steer (Oscar steers → Oscar steered)
   · stop → not-sent tray · approval card buttons. The fake engine takes ~6-9s per turn, hence the long
   waits. Console errors must be 0 everywhere. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function sendDM(page: Page, text: string) {
  // The employee row in the sidebar; its accessible name starts with the Hermes avatar alt text.
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

test("DM: sending a message streams an employee reply", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "What's the state of the relay package?");
  // The engine streams word by word; the last line of the canned reply lands only when the turn is
  // done. Exact match: the same sentence also exists in a muted "latest session" preview.
  await expect(
    page.getByText("Typecheck is clean across 4 packages.", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Channel: @mention opens a thread and the employee replies", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  const box = page.getByPlaceholder(/Message #engineering/);
  await box.fill("@Builder walk me through the envelope contract");
  await box.press("Enter");
  // A thread chip appears in the feed AND the thread panel auto-opens with the reply.
  await expect(
    page.getByText("walk me through the envelope contract").first(),
  ).toBeVisible();
  await expect(
    page.getByText("Typecheck is clean across 4 packages"),
  ).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Steer mid-turn: 'Oscar steers' chip lands as 'Oscar steered'", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Check the relay reconnect plan");
  // Composer switches to the running/steer state; send a steer there.
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });
  await steer.fill("also check the replay window");
  await steer.press("Enter");
  await expect(page.locator('[data-steerstate="pending"]')).toBeVisible();
  // Delivered at the next tool boundary inside the same turn.
  await expect(page.locator('[data-steerstate="landed"]')).toBeVisible({
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test("Stop mid-turn: undelivered steer waits in the not-sent tray", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Summarise the harness reconnect notes");
  const steer = page.getByPlaceholder(/is working\. Enter steers this turn/);
  await expect(steer).toBeVisible({ timeout: 15_000 });
  await steer.fill("hold on, do not open a PR yet");
  await steer.press("Enter");
  await expect(page.locator('[data-steerstate="pending"]')).toBeVisible();
  // ■ before the steer hits a tool boundary → it must NOT be lost: it goes to the tray.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("[data-notsent]")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-notsent]")).toContainText(
    "not sent · turn stopped",
  );
  expect(errors).toEqual([]);
});

test("Approval card: Allow once resolves the confirmation in the thread", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchConsole(page);
  await page.goto("/");
  // The seeded #engineering thread m1 has an approval card (Reviewer asked to run checks).
  await page.getByText("4 replies").first().click();
  const panel = page.locator("aside").last();
  await expect(
    panel.getByText("Approval needed · only Oscar can answer"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Allow once" }).click();
  await expect(panel.getByText("Allowed once by Oscar")).toBeVisible();
  expect(errors).toEqual([]);
});
