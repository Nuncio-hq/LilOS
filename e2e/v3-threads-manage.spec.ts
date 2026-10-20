import { expect, type Page, test } from "@playwright/test";

/**
 * Rename, archive and unarchive a thread, and the engine approval policy,
 * on the prototype (mock company). A thread's ⋯ menu is on its row and in
 * its own header; archived threads leave Live and Recent and live under
 * Threads → All → Archived, where they unarchive.
 */

const T = "t-lil81";
const row = (page: Page) => page.locator(`#v3-main [data-thread-row="${T}"]`);
const menu = (scope: ReturnType<Page["locator"]>) =>
  scope.getByRole("button", { name: "Thread actions", exact: true });

test("a thread renames in place from its row and its header", async ({
  page,
}) => {
  await page.goto("/?page=threads&view=all");
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

test("an archived thread leaves Live and Recent, shows under All → Archived, and unarchives", async ({
  page,
}) => {
  await page.goto("/?page=threads&view=all");
  await expect(page.getByRole("button", { name: /^Archived/ })).toHaveCount(0);
  await row(page).hover();
  await menu(row(page)).click();
  await page.getByRole("menuitem", { name: "Archive thread" }).click();

  // Gone from the list, and from Live (the tabs, not a reload: the mock
  // company lives in memory); present under Archived.
  await expect(row(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Earlier today/ }),
  ).toBeVisible();
  await expect(page.locator("#v3-main")).not.toContainText("Fix the flaky");
  await page.getByRole("button", { name: "Open All" }).click();
  await page.getByRole("button", { name: /Archived \(1\)/ }).click();
  const archived = page.locator(
    `[data-archived-list] [data-thread-row="${T}"]`,
  );
  await expect(archived).toBeVisible();

  // It still opens, and Unarchive is on its menu.
  await menu(archived).click();
  await page.getByRole("menuitem", { name: "Unarchive thread" }).click();
  await expect(row(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Archived/ })).toHaveCount(0);
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
