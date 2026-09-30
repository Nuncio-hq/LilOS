import { expect, type Locator, type Page, test } from "@playwright/test";

/* Issue #326 — the Workbench tab strip must never hard-clip a tab label.
   With six tabs (Changes · Files · Terminal · Browser · Background ·
   Subagents) the strip no longer fits in Focus at ~1288px: justify-center
   overflowed both ways and cut the leftmost tab ("Changes 1" → "nges 1").
   Wanted: short space collapses tabs to icon + count (label → tooltip,
   least-used first, active keeps its label); failing that, the strip
   scrolls left-anchored with an edge fade.

   Red-first: on the pre-fix build the Changes trigger's box pokes out of
   the TabsList's visible box at 1288×700 Focus — the clip check reads
   `data-slot="tabs-trigger"` (pre-existing markup), so the red run fails
   on "tab Changes clipped", not on a missing fixture.

   Note: the seeded helpers finish ~10s in, so running-count assertions run
   while the badges are still live; later legs locate triggers by
   `data-wb-tab`, which survives the badge unmounting. */

const list = (page: Page) => page.locator('[data-slot="tabs-list"]');
const trig = (page: Page, t: string) =>
  list(page).locator(`[data-wb-tab="${t}"]`);

/** Builder's seeded "Why turns get lost after sleep" session → Focus. */
async function openFocus(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: /Builder/ })
    .first()
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
      return [
        ...el.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]'),
      ].map((t) => {
        const b = t.getBoundingClientRect();
        const sp = t.querySelector<HTMLElement>("[data-wb-label]");
        /* No label span → label is shown (pre-fix markup has none). A
             folded tab hides the span; on the pre-fix build there is also
             no aria-label, so the clip check still fails on the old bug. */
        return {
          tab:
            t.dataset.wbTab ??
            t.getAttribute("value") ??
            t.textContent?.trim().slice(0, 24) ??
            "?",
          aria: t.getAttribute("aria-label") ?? "",
          labelVisible:
            sp == null ? true : getComputedStyle(sp).display !== "none",
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
async function expectCompactKeepsBadge(trigLoc: Locator, dataAttr: string) {
  await expect(trigLoc.locator(`[${dataAttr}]`)).toBeVisible();
  await expect(trigLoc.locator("[data-wb-label]:visible")).toHaveCount(0);
  await expect(trigLoc).toHaveAttribute("aria-label", /.+/);
  await expect(trigLoc).toHaveAttribute("title", /.+/);
}

test("AC: no tab clips at 1288 / 900 / ~1040px; collapsed tabs keep icon + count; active keeps its label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  await openFocus(page);

  // The live turn spins helpers up front — while they run, the counts are
  // up. These waits use pre-existing markup (role + the badge spans), so on
  // the pre-fix build they pass and the red lands on the clip check itself.
  const subagents = list(page).getByRole("tab", { name: /Subagents/ });
  const subBadge = subagents.locator("[data-subagents-running]");
  const bgBadge = list(page)
    .getByRole("tab", { name: /Background/ })
    .locator("span.text-emerald-600");
  await expect(subBadge).toBeVisible({ timeout: 15_000 });
  await expect(bgBadge).toBeVisible();

  // Focus follows the agent → Subagents is the active tab and keeps its label.
  await expect(subagents.locator("text=Subagents")).toBeVisible();

  // 1288: nothing clips; the least-used tabs are already icon + count.
  await expectNoClippedTab(page);
  await expectCompactKeepsBadge(trig(page, "background"), "data-bg-running");

  /* Narrower embed (~480px aside below the grid's 46%): more tabs go
     icon-only — Background folds first (least-used). */
  await page.setViewportSize({ width: 1040, height: 700 });
  await expectNoClippedTab(page);
  const folded = await list(page).evaluate(
    (el) => el.querySelectorAll(".wb-fold").length,
  );
  expect(folded).toBeGreaterThan(0);
  await expect(trig(page, "background")).toHaveClass(/wb-fold/);
  // If the helpers are still running, the folded strip still shows counts.
  // (Subagents is the active tab here, so it keeps its label — only its
  // count matters; the folded badge shape was already asserted at 1288.)
  if (await bgBadge.isVisible().catch(() => false)) {
    await expectCompactKeepsBadge(trig(page, "background"), "data-bg-running");
  }
  if (await subBadge.isVisible().catch(() => false)) {
    await expect(subBadge).toBeVisible();
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
