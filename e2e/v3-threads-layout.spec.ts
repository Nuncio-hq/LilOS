import { expect, test } from "@playwright/test";

/**
 * Threads' lists keep every title readable beside an open thread: at 1280px
 * (the peek takes more than half the page) the title column truncates, it
 * never collapses to nothing. Prototype app, mock company.
 */

for (const view of ["live", "all", "agent"] as const) {
  for (const width of [1280, 1100]) {
    test(`${view} list keeps its titles readable at ${width}px with a thread open`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/?page=threads&view=${view}&open=thread:t-lil81`);
      const rows = page.locator("#v3-main [data-thread-row]");
      await expect(rows.first()).toBeVisible();
      const titles = await rows.evaluateAll((els) =>
        els.map((row) => {
          const title = row.querySelector<HTMLElement>(
            '[role="button"] > span',
          );
          return title ? title.getBoundingClientRect().width : 0;
        }),
      );
      expect(titles.length).toBeGreaterThan(0);
      for (const w of titles)
        expect(w, `a title column is ${w}px wide`).toBeGreaterThan(80);
    });
  }
}
