import { expect, type Page, test } from "@playwright/test";

/**
 * Rename, mark done and mark not done a thread, and the engine approval
 * policy, on the prototype (mock company). A thread's ⋯ menu is on its row
 * and in its own header; a running thread sits folded under Working (#862),
 * and a done thread leaves the list for the Done shelf, where Not done
 * brings it back (#887).
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

test("a done thread leaves the list for the Done shelf, and Not done brings it back", async ({
  page,
}) => {
  await page.goto("/?page=threads");
  // The mock's shelf starts with three parked threads (#862).
  await expect(settledFold(page)).toHaveText("Done (3)");
  await openWorking(page);
  await row(page).hover();
  await menu(row(page)).click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();

  // Gone from the list; present on the Done shelf.
  await expect(row(page)).toHaveCount(0);
  await expect(settledFold(page)).toHaveText("Done (4)");
  await settledFold(page).click();
  const settled = page.locator(`[data-settled-list] [data-thread-row="${T}"]`);
  await expect(settled).toBeVisible();
  // Done took the pin and snooze off: the shelf row offers Not done.
  await expect(settled).toContainText("Done");

  // It still opens, and Not done is on its menu.
  await menu(settled).click();
  await page.getByRole("menuitem", { name: "Not done" }).click();
  await expect(row(page)).toBeVisible();
  await expect(settledFold(page)).toHaveText("Done (3)");
});

test("Settings → General draws the engine approval policy and keeps the pick", async ({
  page,
}) => {
  await page.goto("/?page=settings&view=general");
  const policy = page.getByRole("radiogroup", {
    name: "Engine approval policy",
  });
  await expect(policy).toBeVisible();
  await expect(
    policy.getByRole("radio", { name: "Smart", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await policy.getByRole("radio", { name: "Off", exact: true }).click();
  await expect(
    policy.getByRole("radio", { name: "Off", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    policy.getByRole("radio", { name: "Smart", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});
