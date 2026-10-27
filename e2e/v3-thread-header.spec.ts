import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * #886: a thread's header is the title and ONE line — status · started ·
 * turns on the left, "Changes N" (only while files changed) and ⋯ on the
 * right — so the first message starts high in the window. Every other work
 * icon and the context % meter are labeled rows inside that ⋯ menu.
 * Prototype app, mock company; t-hb12-build has edits, a PR and a running
 * job to fill the menu.
 */
const OPEN = "/?page=threads&open=thread:t-hb12-build";
/* t-hb12-plan: same shell, but nothing changed — no Changes button at all. */
const OPEN_PLAIN = "/?page=threads&open=thread:t-hb12-plan";
const peek = (page: Page) => page.locator('aside[aria-label="Opened record"]');

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b, "the element has a box").not.toBeNull();
  return b as NonNullable<typeof b>;
}

test("wide: Changes and ⋯ share the status line; strip and meter are inside ⋯", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(OPEN);
  const header = peek(page).locator("[data-thread-header]");
  await expect(header).toBeVisible();

  const status = await box(header.getByText("Finished", { exact: true }));
  const changes = header.locator('[data-work-tab="changes"]');
  const menu = header.getByRole("button", { name: "Thread actions" });
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  const row = [await box(changes), await box(menu)];
  for (const b of row)
    expect(Math.abs(mid(b) - mid(status)), "one line").toBeLessThan(8);
  // Left to right: the facts, then Changes, then ⋯.
  expect(row[0].x).toBeGreaterThan(status.x + status.width);
  expect(row[1].x).toBeGreaterThan(row[0].x + row[0].width);
  // Changes names itself and its count — it is not a bare icon.
  await expect(changes).toContainText(/Changes\s*\d/);
  // The meter and the rest of the strip are not loose in the header.
  await expect(
    header.getByRole("button", { name: /Context used:/ }),
  ).toHaveCount(0);
  await expect(header.locator("[data-work-strip]")).toHaveCount(0);

  // Inside ⋯: the other surfaces, labeled, and the context meter row.
  await menu.click();
  const list = page.locator('[role="menu"][aria-label="Thread actions"]');
  await expect(list).toBeVisible();
  await expect(list.locator('[data-work-tab="files"]')).toContainText("Files");
  await expect(list.locator('[data-work-tab="terminal"]')).toContainText(
    "Terminal",
  );
  await expect(list.locator('[data-work-tab="preview"]')).toContainText(
    "Preview",
  );
  await expect(list.locator('[data-work-tab="pr"]')).toContainText("PR");
  await expect(list.locator('[data-work-tab="details"]')).toContainText(
    "Details",
  );
  await expect(
    list.getByRole("menuitem", { name: /Context used:/ }),
  ).toContainText("%");

  // The title is one row above; the first turn follows the line closely.
  await page.keyboard.press("Escape");
  const title = await box(header.locator("[data-session-title]"));
  expect(title.y + title.height).toBeLessThanOrEqual(status.y + 4);
  const first = await box(peek(page).locator("[data-msg]").first());
  expect(
    first.y,
    "first message, px from the window's top",
  ).toBeLessThanOrEqual(140);
});

test("narrow: the same one line holds, and the menu still labels its rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(OPEN);
  const header = peek(page).locator("[data-thread-header]");
  await expect(header).toBeVisible();

  const status = await box(header.getByText("Finished", { exact: true }));
  const changes = await box(header.locator('[data-work-tab="changes"]'));
  const menu = header.getByRole("button", { name: "Thread actions" });
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(mid(changes) - mid(status))).toBeLessThan(8);
  expect(Math.abs(mid(await box(menu)) - mid(status))).toBeLessThan(8);
  await expect(header.locator('[data-work-tab="changes"]')).toContainText(
    /Changes\s*\d/,
  );

  await menu.click();
  const list = page.locator('[role="menu"][aria-label="Thread actions"]');
  await expect(list).toBeVisible();
  await expect(list.locator('[data-work-tab="details"]')).toContainText(
    "Details",
  );
  await expect(
    list.getByRole("menuitem", { name: /Context used:/ }),
  ).toBeVisible();
});

test("no changes: the header names no surface at all — ⋯ still holds the rest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(OPEN_PLAIN);
  const header = peek(page).locator("[data-thread-header]");
  await expect(header).toBeVisible();

  await expect(header.locator('[data-work-tab="changes"]')).toHaveCount(0);
  const menu = header.getByRole("button", { name: "Thread actions" });
  await menu.click();
  const list = page.locator('[role="menu"][aria-label="Thread actions"]');
  await expect(list.locator('[data-work-tab="changes"]')).toHaveCount(0);
  await expect(list.locator('[data-work-tab="details"]')).toBeVisible();
});
