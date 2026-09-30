import { expect, type Locator, type Page, test } from "@playwright/test";

/* Issue #305 — a step whose output is one very long unbroken token must stay
   inside the Tool card: it wraps or scrolls inside; the chat column never
   scrolls sideways, and the output area is height-bounded (max-h-64 like the
   terminal step). Covers the generic output and, beside it, the other
   long-text surfaces: a long input value, a long path, a long terminal line. */

async function openStepsThread(page: Page): Promise<Locator> {
  await page.goto("/");
  // Seeded dm-builder thread "What's left before the relay…" (3 replies).
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  await page.getByText("3 replies").first().click();
  const steps = page
    .locator("aside")
    .last()
    .locator("[data-tasksteps]")
    .first();
  await steps.locator("button").first().click(); // expand "5 steps"
  return steps;
}

const toolCards = (steps: Locator) =>
  steps.locator('[data-slot="collapsible"]');

async function expandAllCards(steps: Locator) {
  for (const card of await toolCards(steps).all()) {
    await card.locator("button").first().click();
  }
}

/** Every tool card stays inside the column: nothing spills horizontally. */
async function expectCardsInside(steps: Locator) {
  for (const card of await toolCards(steps).all()) {
    await expect
      .poll(async () => card.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBe(0);
  }
}

async function columnOverflowPx(page: Page) {
  return page
    .locator("aside")
    .last()
    .locator('[role="log"]')
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
}

test("AC-1..3,5: long unbroken output stays inside the card, wide + narrow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
  await expandAllCards(steps);
  await expect(toolCards(steps)).toHaveCount(5);
  await expectCardsInside(steps);
  expect(await columnOverflowPx(page)).toBe(0);
  // Same in a narrow (~800px) window.
  await page.setViewportSize({ width: 800, height: 700 });
  await expectCardsInside(steps);
  expect(await columnOverflowPx(page)).toBe(0);
});

test("AC-2 first character of each output line is visible (no left clip)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
  await expandAllCards(steps);
  const out = toolCards(steps).nth(2);
  // The output block is horizontally scrolled to its start.
  const clip = await out.evaluate(
    (el) =>
      [...el.querySelectorAll("div,p,pre")].filter(
        (x) => x.scrollLeft !== 0 || x.scrollWidth > x.clientWidth,
      ).length,
  );
  expect(clip).toBe(0);
});

test("AC-4 a huge output is height-bounded with its own vertical scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
  await expandAllCards(steps);
  const out = toolCards(steps).nth(2);
  // Some box inside the card scrolls vertically within a bounded height.
  const bounded = await out.evaluate((el) =>
    [...el.querySelectorAll("div")].some(
      (x) => x.scrollHeight > x.clientHeight + 8 && x.clientHeight <= 280,
    ),
  );
  expect(bounded).toBe(true);
});
