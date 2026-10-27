import { expect, type Page, test } from "@playwright/test";

/**
 * Rename, settle and un-settle a thread on the prototype (mock company).
 * A thread's ⋯ menu is on its row and in its own header; a running thread
 * sits folded under Working (#862), and a settled thread leaves the list
 * for the Settled shelf, where it un-settles.
 */

const T = "t-lil81";
const row = (page: Page) => page.locator(`#v3-main [data-thread-row="${T}"]`);
const menu = (scope: ReturnType<Page["locator"]>) =>
  scope.getByRole("button", { name: "Thread actions", exact: true });
/* t-lil81 is working: its row lives under the folded Working section. The
   sidebar renders the same fold — scope every shelf click to #v3-main. */
const openWorking = (page: Page) =>
  page.locator('#v3-main [data-fold="working"] > button').click();
const settledFold = (page: Page) =>
  page.locator('#v3-main [data-fold="settled"] > button');

test("a thread renames in place from its row and its header", async ({
  page,
}) => {
  await page.goto("/?page=threads");
  await openWorking(page);
  await row(page).hover();
  await menu(row(page)).click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const input = page.getByRole("textbox", { name: "Thread title" });
  // Esc keeps the old title.
  await input.fill("never saved");
  await input.press("Escape");
  await expect(row(page)).not.toContainText("never saved");
  await row(page).hover();
  await menu(row(page)).click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  await input.fill("Renamed from the row");
  await input.press("Enter");
  await expect(row(page)).toContainText("Renamed from the row");

  // The thread's own header renames it too.
  await row(page).click();
  const peek = page.getByRole("complementary", { name: "Opened record" });
  await expect(peek.getByRole("heading", { level: 1 })).toHaveText(
    "Renamed from the row",
  );
  await menu(peek).click();
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  await peek
    .getByRole("textbox", { name: "Thread title" })
    .fill("Renamed in the header");
  await peek.getByRole("textbox", { name: "Thread title" }).press("Enter");
  await expect(peek.getByRole("heading", { level: 1 })).toHaveText(
    "Renamed in the header",
  );
  await expect(row(page)).toContainText("Renamed in the header");
});

test("a settled thread leaves the list for the Settled shelf, and un-settles", async ({
  page,
}) => {
  await page.goto("/?page=threads");
  // The mock's shelf starts with three parked threads (#862).
  await expect(settledFold(page)).toHaveText("Settled (3)");
  await openWorking(page);
  await row(page).hover();
  await menu(row(page)).click();
  await page.getByRole("menuitem", { name: "Settle thread" }).click();

  // Gone from the list; present on the Settled shelf.
  await expect(row(page)).toHaveCount(0);
  await expect(settledFold(page)).toHaveText("Settled (4)");
  await settledFold(page).click();
  const settled = page.locator(`[data-settled-list] [data-thread-row="${T}"]`);
  await expect(settled).toBeVisible();
  // Settling took the pin and snooze off: the shelf row offers Un-settle.
  await expect(settled).toContainText("Settled");

  // It still opens, and Un-settle is on its menu.
  await menu(settled).click();
  await page.getByRole("menuitem", { name: "Un-settle thread" }).click();
  await expect(row(page)).toBeVisible();
  await expect(settledFold(page)).toHaveText("Settled (3)");
});

/* #884: Settings shows only LilOS's Ask / Full access — the engine's
   Smart / Manual / Off row is gone even though the mock still feeds it. */
test("Settings → General keeps Ask / Full access and no engine policy row", async ({
  page,
}) => {
  await page.goto("/?page=settings&view=general");
  const approvals = page.getByRole("radiogroup", {
    name: "Approvals",
    exact: true,
  });
  await expect(approvals).toBeVisible();
  await expect(
    approvals.getByRole("radio", { name: "Ask before risky commands" }),
  ).toBeVisible();
  await expect(
    approvals.getByRole("radio", { name: "Full access" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Engine approval policy" }),
  ).toHaveCount(0);
  for (const name of ["Smart", "Manual", "Off"])
    await expect(page.getByRole("radio", { name, exact: true })).toHaveCount(0);
});
