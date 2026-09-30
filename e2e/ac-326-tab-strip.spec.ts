import { expect, type Locator, type Page, test } from "@playwright/test";

/* Issue #326 — the Workbench tab strip must never hard-clip a tab label.
   With six tabs (Changes · Files · Terminal · Browser · Background ·
   Subagents) the strip no longer fits in Focus at ~1288px: justify-center
   overflowed both ways and cut the leftmost tab ("Changes 1" → "nges 1").
   Wanted: short space collapses tabs to icon + count (label → tooltip,
   least-used first, active keeps its label); failing that, the strip
   scrolls left-anchored with an edge fade.

   Red-first: on the pre-fix build the Changes trigger's box pokes out of
   the TabsList's visible box at 1288×700 Focus. */

const list = (page: Page) => page.locator('[data-slot="tabs-list"]');
const triggers = (page: Page) => list(page).getByRole("tab");

/** Builder's seeded "Why turns get lost after sleep" session → Focus. */
async function openFocus(page: Page) {
  await page.goto("/");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const row = page
    .locator("[data-session]")
    .filter({ hasText: "Why turns get lost after sleep" });
  await row.getByRole("button", { name: /replies|reply/ }).click();
  await page.getByTitle("Focus", { exact: true }).click();
  // Below ~lg the Workbench starts closed; the header toggle opens its overlay.
  if (
    !(await list(page)
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByTitle("Workbench", { exact: true }).click();
  }
  await expect(list(page)).toBeVisible({ timeout: 15_000 });
  await expect(triggers(page).first()).toBeVisible();
}

/** Every trigger sits inside the list's visible box — or is icon-only with
    an aria-label (its label moved to the tooltip). Retried on the invariant
    itself: after a resize the strip needs a frame for the ResizeObserver to
    re-fold — the invariant must hold once laid out (and never does on the
    pre-fix build, which keeps this red-first). Geometry is read in one
    atomic evaluate so a re-fold can't tear the measurement. */
async function expectNoClippedTab(page: Page) {
  await expect(list(page)).toBeVisible();
  await expect(async () => {
    const read = await list(page).evaluate((el) => {
      const lb = el.getBoundingClientRect();
      return [...el.querySelectorAll<HTMLElement>("[data-wb-tab]")].map((t) => {
        const b = t.getBoundingClientRect();
        const sp = t.querySelector<HTMLElement>("[data-wb-label]");
        return {
          tab: t.dataset.wbTab ?? "?",
          aria: t.getAttribute("aria-label") ?? "",
          labelVisible: !!sp && getComputedStyle(sp).display !== "none",
          inside:
            b.x >= lb.x - 1 &&
            b.y >= lb.y - 1 &&
            b.right <= lb.right + 1 &&
            b.bottom <= lb.bottom + 1,
        };
      });
    });
    expect(read.length).toBeGreaterThan(0);
    for (const c of read)
      expect(
        c.inside || (c.aria.length > 0 && !c.labelVisible),
        `tab ${c.aria || c.tab} clipped`,
      ).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/** A compacted trigger keeps icon + running count + tooltip label. */
async function expectCompactKeepsBadge(trig: Locator, dataAttr: string) {
  await expect(trig.locator(`[${dataAttr}]`)).toBeVisible();
  await expect(trig.locator("[data-wb-label]:visible")).toHaveCount(0);
  await expect(trig).toHaveAttribute("aria-label", /.+/);
  await expect(trig).toHaveAttribute("title", /.+/);
}

test("AC: no tab clips at 1288 / 900 / ~1040px; collapsed tabs keep icon + count; active keeps its label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  await openFocus(page);
  // The live turn spins 3 helpers up front — the Subagents count is up.
  const subagents = triggers(page)
    .filter({ has: page.locator("[data-subagents-running]") })
    .first();
  await expect(subagents).toBeVisible({ timeout: 15_000 });
  await expectNoClippedTab(page);

  /* Narrower embed (~480px aside below the grid's 46%): more tabs go
     icon-only, Background + Subagents first — running counts stay. */
  await page.setViewportSize({ width: 1040, height: 700 });
  await expectNoClippedTab(page);
  const background = triggers(page)
    .filter({ has: page.locator("[data-bg-running]") })
    .first();
  if (
    await background
      .locator("[data-wb-label]:visible")
      .count()
      .then((n) => n === 0)
  ) {
    await expectCompactKeepsBadge(background, "data-bg-running");
  }
  if (
    await subagents
      .locator("[data-wb-label]:visible")
      .count()
      .then((n) => n === 0)
  ) {
    await expectCompactKeepsBadge(subagents, "data-subagents-running");
  }

  // 900px window: the Workbench is the overlay strip — still nothing clips.
  await page.setViewportSize({ width: 900, height: 700 });
  if (
    !(await list(page)
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByTitle("Workbench", { exact: true }).click();
  }
  await expectNoClippedTab(page);

  // The active tab keeps its label even when every other tab is icons.
  await subagents.click();
  await expect(subagents.locator("[data-wb-label]:visible")).toBeVisible();

  // Back up at 1288 everything fits again (labels return).
  await page.setViewportSize({ width: 1288, height: 700 });
  await expectNoClippedTab(page);
});
