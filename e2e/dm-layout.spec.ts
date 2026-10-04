import { expect, type Page, test } from "@playwright/test";
import { bootStack } from "./helpers/stack";

/**
 * DM page layout. With no session open, the employee feed must fill the
 * window: Oscar saw an empty column on the right of the desktop app before
 * any thread or workbench was opened. Layout needs a real browser, so this is
 * an e2e over the live web app (engine-fake).
 */

const PROMPT = "What does the replay contract carry?"; // engine-fake script

async function dmDefault(page: Page, webUrl: string) {
  await page.goto(`${webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  // First run shows the welcome overlay; its button opens the DM.
  const dmBtn = page.getByRole("button", {
    name: /open dm|set up later|message/i,
  });
  if (
    await dmBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dmBtn.first().click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page).toHaveURL(/\/dm\//);
}

/* The DM page's middle pane is EmployeeHome's <main>. With no session open
   there is no thread panel, so it must reach the window's right edge — no
   reserved-but-empty column (Oscar's report on the desktop app). */
const mainPane = (page: Page) => page.locator("main").first();

/* The pane must reach the window's inner edge. In a browser tab the app is a
   floating window with a 14px margin and a 1px frame border (#246), so
   measure against the frame, not the viewport; the 0.5s rise animation
   scales the pane in from 0.985 (~7px inset mid-flight), so settle first.
   Tolerance is 3 (subpixel + radius rounding); the regression this guards is
   a ~300px reserved column. */
async function rightGapSettled(page: Page): Promise<number> {
  let gap = Infinity;
  await expect
    .poll(async () => {
      gap = await rightGap(page);
      return gap;
    })
    .toBeLessThanOrEqual(3);
  return gap;
}
async function rightGap(page: Page): Promise<number> {
  const box = await mainPane(page).boundingBox();
  const edge = await page.evaluate(() => {
    const frame = document.querySelector(".lilos-desktop");
    if (!frame) return document.documentElement.clientWidth;
    const r = frame.getBoundingClientRect();
    const bw = parseFloat(getComputedStyle(frame).borderRightWidth) || 0;
    return r.right - bw;
  });
  if (!box) throw new Error("DM main pane not laid out");
  return Math.round(edge - (box.x + box.width));
}

test("DM page: with no session open the feed fills the window (no empty right column)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const stack = await bootStack("dmfill", {
    relay: 4630,
    feed: 4631,
    web: 5220,
  });
  try {
    await dmDefault(page, stack.webUrl);
    await expect(mainPane(page)).toBeVisible();
    expect(await rightGapSettled(page)).toBeLessThanOrEqual(3);

    // With a session open, Focus takes over and fills the window (#114) —
    // still no reserved-but-empty column. (This session has no folder, so
    // the Workbench stays hidden; AC-114 covers the Workbench layout.)
    const box = page.locator("textarea").last();
    await box.fill(PROMPT);
    await box.press("Enter");
    await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+\/focus/, {
      timeout: 30_000,
    });
    expect(await rightGapSettled(page)).toBeLessThanOrEqual(3);

    // The plain thread URL still gives the quick-peek panel (right column).
    await page.goto(page.url().replace(/\/focus$/, ""));
    // The panel header shows the session's title (#137), not "Session".
    const panel = page.locator("[data-session-title]").first();

    // The thread header shows the session's auto title (placeholder →
    // engine-written, #137) — the prompt's own words land there first.
    await expect(
      page
        .locator("main")
        .getByText(
          /What does the replay contract carry|What Does The Replay Contract Carry/,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    expect(await rightGap(page)).toBeGreaterThan(300);

    // Back to the employee (session closed): the feed fills the window again.
    await page
      .locator("aside")
      .getByRole("button", { name: /default/i })
      .click();
    await expect(page).toHaveURL(/\/dm\/[^/]+$/);
    expect(await rightGapSettled(page)).toBeLessThanOrEqual(3);
  } finally {
    await stack.stop();
  }
});
