import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  panelIntoFocus,
  pickPorts,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Page layout beside the side peek. With no thread open, the page must fill
 * the window: Oscar saw an empty column on the right of the desktop app
 * before any thread or workbench was opened. Layout needs a real browser, so
 * this is an e2e over the live web app (engine-fake).
 *
 * v3: the page is the shell's one `<main>` (the Threads page); an open
 * thread takes the right column as the side peek, and the widened peek
 * (Focus) takes the whole window.
 */

const PROMPT = "What does the replay contract carry?"; // engine-fake script

/* The Threads page's pane is the shell's one <main> landmark. With no
   thread open there is no peek, so it must reach the window's right edge — no
   reserved-but-empty column (Oscar's report on the desktop app). */
const mainPane = (page: Page) => page.locator("#v3-main");

/* The pane must reach the window's inner edge. The 0.5s rise animation
   scales the pane in from 0.985 (~7px inset mid-flight), so settle first.
   Tolerance is 3 (subpixel + radius rounding); the regression this guards is
   a ~300px reserved column. */
async function rightGapSettled(page: Page, pane: Locator): Promise<number> {
  let gap = Number.POSITIVE_INFINITY;
  await expect
    .poll(async () => {
      gap = await rightGap(page, pane);
      return gap;
    })
    .toBeLessThanOrEqual(3);
  return gap;
}
async function rightGap(page: Page, pane: Locator): Promise<number> {
  const box = await pane.boundingBox();
  const edge = await page.evaluate(() => document.documentElement.clientWidth);
  if (!box) throw new Error("pane not laid out");
  return Math.round(edge - (box.x + box.width));
}

test("Threads page: with no thread open the page fills the window (no empty right column)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const stack = await bootStack("dmfill", await pickPorts());
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    await page.goto(`${stack.webUrl}/#?page=threads`);
    await expect(v3Peek(page)).toHaveCount(0);
    await expect(mainPane(page)).toBeVisible();
    expect(await rightGapSettled(page, mainPane(page))).toBeLessThanOrEqual(3);

    // With a thread open, the send lands in the side peek (#577) — widening
    // it (Focus) takes over and fills the window (#114) — still no
    // reserved-but-empty column. (This thread has no folder, so the
    // Workbench stays hidden; AC-114 covers the Workbench layout.)
    await startChat(page, stack.webUrl, agent, PROMPT);
    await panelIntoFocus(page);
    expect(await rightGapSettled(page, v3Peek(page))).toBeLessThanOrEqual(3);

    // The plain thread URL still gives the quick-peek panel (right column).
    await page.goto(page.url().replace(/&full=1$/, ""));
    // The panel header shows the session's title (#137), not "Thread".
    const panel = page.locator("[data-session-title]").first();

    // The thread header shows the session's auto title (placeholder →
    // engine-written, #137) — the prompt's own words land there first.
    await expect(
      v3Peek(page)
        .getByText(
          /What does the replay contract carry|What Does The Replay Contract Carry/,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    expect(await rightGap(page, mainPane(page))).toBeGreaterThan(300);

    // Close the thread (session closed): the page fills the window again.
    await v3Peek(page).getByTitle("Close (Esc)").click();
    await expect(page).toHaveURL(/page=threads$/);
    expect(await rightGapSettled(page, mainPane(page))).toBeLessThanOrEqual(3);
  } finally {
    await stack.stop();
  }
});

/* #660: the flake was `boundingBox()` returning null — the resolved <main>
   was detached again by the time the box was measured. The page's pane is
   one <main> that must survive send → Focus: LILOS_SUMMARY_DELAY_MS holds
   the new thread's summary back so the row lands AFTER the widen — the exact
   window the CI failure sampled inside. The assertion is on the element
   itself: a pane that survives the transition still has a box; a remounted
   one never does (detached → null, deterministically). */
test("AC-660 the page's main pane stays mounted through send → Focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  const stack = await bootStack("dmpane", await pickPorts(), {
    LILOS_SUMMARY_DELAY_MS: "1500",
  });
  try {
    const agent = await openDefaultAgent(page, stack.webUrl);
    // A new chat beside Threads: the page behind the draft is the pane.
    await page.goto(
      `${stack.webUrl}/#?page=threads&open=newchat:${encodeURIComponent(agent.id)}`,
    );
    await expect(mainPane(page)).toBeVisible();
    const feedMain = await mainPane(page).elementHandle();
    expect(feedMain, "page pane handle before send").not.toBeNull();

    const box = v3Peek(page).getByPlaceholder(`Message ${agent.name}…`);
    await box.fill(PROMPT);
    await v3Peek(page).getByRole("button", { name: "Send" }).click();
    /* #577: the send lands in the side peek; open Focus the way the user
       does — widening it. The summary-delayed row still lands inside the
       swap window this AC samples. */
    await panelIntoFocus(page);
    // Wait for the Focus surface itself — with the summary held back this
    // settles only once the delayed row lands and Focus takes the pane.
    await expect(v3Peek(page).locator("[data-thread]")).toBeVisible({
      timeout: 30_000,
    });

    // The pane element measured before the send must still be mounted:
    // a remount here is what detached the node and null'd boundingBox.
    expect(await feedMain?.boundingBox()).not.toBeNull();
    expect(await rightGapSettled(page, v3Peek(page))).toBeLessThanOrEqual(3);
  } finally {
    await stack.stop();
  }
});
