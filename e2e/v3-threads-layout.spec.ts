import { expect, test } from "@playwright/test";

/**
 * Threads' single list keeps every title readable beside an open thread,
 * in each "Group by" mode (#862): at 1280px (the peek takes more than half
 * the page) the title truncates, it never collapses to nothing. Prototype
 * app, mock company.
 */

for (const group of ["Section", "Agent", "Project"] as const) {
  for (const width of [1280, 1100]) {
    test(`${group} grouping keeps its titles readable at ${width}px with a thread open`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/?page=threads&open=thread:t-lil81");
      if (group !== "Section")
        await page.getByRole("radio", { name: group, exact: true }).click();
      const rows = page.locator("#v3-main [data-thread-row]");
      await expect(rows.first()).toBeVisible();
      /* A title reads when it shows in full or, truncated, keeps at least
         80px: the merged row's title is fluid, so a short title is
         legitimately narrower than 80 (#862). scrollWidth is a whole px
         while the rect is fractional — a 1px slack absorbs that, and a
         truly truncated title still needs the full 80. */
      const titles = await rows.evaluateAll((els) =>
        els.map((row) => {
          const title = row.querySelector<HTMLElement>("[data-thread-title]");
          if (!title) return { w: 0, full: 0 };
          return {
            w: title.getBoundingClientRect().width,
            full: title.scrollWidth,
          };
        }),
      );
      expect(titles.length).toBeGreaterThan(0);
      for (const { w, full } of titles)
        expect(
          w + 1,
          `a title column is ${w}px wide (text ${full}px)`,
        ).toBeGreaterThanOrEqual(Math.min(full, 81));
    });
  }
}
