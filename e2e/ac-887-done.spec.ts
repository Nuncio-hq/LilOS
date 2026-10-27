import { expect, type Page, test } from "@playwright/test";

/**
 * #887: Threads is one list by status — Pinned · Active · Working ·
 * Snoozed · Done — and parking reads Done / Not done in the UI (the wire
 * still says settle/archive). No tabs, no Group-by switch, no counters;
 * the project page uses the same statuses. Prototype app, mock company.
 */

const main = (page: Page) => page.locator("#v3-main");
const row = (page: Page, id: string) =>
  main(page).locator(`[data-thread-row="${id}"]`);
const menu = async (page: Page, id: string) => {
  const r = row(page, id);
  await r.hover();
  await r.getByRole("button", { name: "Thread actions", exact: true }).click();
};
const foldButton = (page: Page, scope: string, fold: string) =>
  main(page).locator(`${scope} [data-fold="${fold}"] > button`);

test("Threads is one list by status — no tabs, no Group by, no counters", async ({
  page,
}) => {
  await page.goto("/?page=threads");

  /* The five statuses, in order: Pinned and Active read off the list;
     Working, Snoozed and Done sit folded. */
  await expect(main(page).getByText("Pinned", { exact: true })).toBeVisible();
  await expect(main(page).getByText("Active", { exact: true })).toBeVisible();
  await expect(foldButton(page, "", "working")).toContainText("Working");
  await expect(foldButton(page, "", "snoozed")).toContainText("Snoozed");
  await expect(foldButton(page, "", "settled")).toContainText("Done");

  /* Gone: the Threads/Scheduled tabs, the Group-by switch, the counters. */
  await expect(
    main(page).getByRole("button", { name: "Scheduled" }),
  ).toHaveCount(0);
  await expect(main(page).getByText("Group by:")).toHaveCount(0);
  await expect(
    main(page).getByRole("radiogroup", { name: "Group threads by" }),
  ).toHaveCount(0);
  await expect(main(page).getByText("finished, not seen")).toHaveCount(0);
  await expect(main(page).getByText(/^\d+ stuck$/)).toHaveCount(0);
});

test("the ⋯ menu says Done / Not done with no Auto-settle, and Done folds", async ({
  page,
}) => {
  await page.goto("/?page=threads");
  await foldButton(page, "", "working").click();
  const T = "t-lil81";

  await menu(page, T);
  await expect(
    page.getByRole("menuitem", { name: "Done", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Snooze" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Pin thread" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Auto-settle" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("menuitem", { name: /Settle/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();

  // Off the list, onto the Done shelf (three already parked there).
  await expect(row(page, T)).toHaveCount(0);
  await expect(foldButton(page, "", "settled")).toContainText("Done (4)");
  await foldButton(page, "", "settled").click();
  await expect(row(page, T)).toBeVisible();

  /* The shelf row's menu leads with Not done — no pin, snooze or
     Auto-settle on a parked thread. */
  await menu(page, T);
  await expect(page.getByRole("menuitem", { name: "Not done" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Pin thread" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("menuitem", { name: "Snooze" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Auto-settle" })).toHaveCount(
    0,
  );
  await page.getByRole("menuitem", { name: "Not done" }).click();
  await expect(foldButton(page, "", "settled")).toContainText("Done (3)");
  /* Back where it was: still working, so back under the Working fold. */
  await expect(row(page, T)).toBeVisible();
});

test("the project page uses the same statuses", async ({ page }) => {
  /* The lilos project spans the statuses the mock has: a pinned chat,
     two active ones, a working one, and a parked (Done) one. */
  await page.goto("/?page=project&id=lilos");
  const threads = main(page).locator("[data-project-threads]");
  await expect(threads.getByText("Pinned", { exact: true })).toBeVisible();
  await expect(row(page, "t-chat-relay")).toBeVisible();
  await expect(threads.getByText("Active", { exact: true })).toBeVisible();
  await expect(foldButton(page, "", "working")).toContainText("Working (1)");
  await expect(foldButton(page, "", "settled")).toContainText("Done (1)");
  /* The old Live/Past split is gone. */
  await expect(main(page).getByText("Live threads")).toHaveCount(0);
  await expect(main(page).getByText("Past threads")).toHaveCount(0);

  /* A finished-but-open thread reads Active in both places (#887): on the
     project page it sits under Active, the same as on Threads — it is no
     longer a "Past thread". */
  await page.goto("/?page=threads");
  await expect(row(page, "t-chat-prs")).toBeVisible();
});
