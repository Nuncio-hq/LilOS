import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * #797: a thread's header is the title and ONE line — status · started ·
 * turns on the left, the work strip, the context meter and ⋯ on the right —
 * so the first message starts high in the window. When the column is narrow
 * the strip drops to a row of its own, labels back. Prototype app, mock
 * company; t-hb12-plan has no background job to lengthen the line.
 */

/* t-hb12-plan: finished, unpinned, never parked — nothing lengthens the line
   (t-lil77 now sleeps on the Snoozed shelf and so draws the park line, #862). */
const OPEN = "/?page=threads&open=thread:t-hb12-plan";
const peek = (page: Page) => page.locator('aside[aria-label="Opened record"]');

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b, "the element has a box").not.toBeNull();
  return b as NonNullable<typeof b>;
}

test("wide: the strip, meter and ⋯ share the status line, and the first message starts high", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(OPEN);
  const header = peek(page).locator("[data-thread-header]");
  await expect(header).toBeVisible();

  const status = await box(header.getByText("Finished", { exact: true }));
  const strip = await box(header.locator("[data-work-strip]"));
  const meter = await box(
    header.getByRole("button", { name: /Context used:/ }),
  );
  const menu = await box(
    header.getByRole("button", { name: "Thread actions" }),
  );
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  for (const b of [strip, meter, menu])
    expect(Math.abs(mid(b) - mid(status)), "one line").toBeLessThan(8);
  // Left to right: the facts, then the strip, then the meter and ⋯.
  expect(strip.x).toBeGreaterThan(status.x + status.width);
  expect(meter.x).toBeGreaterThan(strip.x + strip.width);
  expect(menu.x).toBeGreaterThan(meter.x);
  // Icons, not labels, at this width — each still names itself.
  const changes = header.getByRole("button", { name: "Changes" });
  await expect(changes).toBeVisible();
  expect((await box(changes)).width).toBeLessThan(40);

  // The title is one row above; the first turn follows the line closely.
  const title = await box(header.locator("[data-session-title]"));
  expect(title.y + title.height).toBeLessThanOrEqual(status.y + 4);
  const first = await box(peek(page).locator("[data-msg]").first());
  expect(
    first.y,
    "first message, px from the window's top",
  ).toBeLessThanOrEqual(140);
});

test("narrow: the strip takes a row of its own below the facts, labels back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(OPEN);
  const header = peek(page).locator("[data-thread-header]");
  await expect(header).toBeVisible();

  const status = await box(header.getByText("Finished", { exact: true }));
  const strip = await box(header.locator("[data-work-strip]"));
  const meter = await box(
    header.getByRole("button", { name: /Context used:/ }),
  );
  expect(strip.y).toBeGreaterThan(status.y + status.height);
  // The meter and ⋯ stay at the right end of the facts' line.
  expect(
    Math.abs(meter.y + meter.height / 2 - (status.y + status.height / 2)),
  ).toBeLessThan(8);
  expect(
    (await box(header.getByRole("button", { name: "Changes" }))).width,
  ).toBeGreaterThan(60);
});
