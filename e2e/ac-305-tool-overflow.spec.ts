import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectSettled } from "./helpers/approvals";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  threadUrl,
} from "./helpers/stack";

/* Issue #305 — a step whose output is one very long unbroken token must stay
   inside the Tool card: it wraps or scrolls inside; the chat column never
   scrolls sideways, and the output area is height-bounded (max-h-64 like the
   terminal step). Covers the generic output and, beside it, the other
   long-text surfaces: a long input value, a long path, a long terminal line.

   Real app: engine-fake's `longoutput:` turn mints the five steps (the old
   spec read them off the prototype's seeded thread). The thread opens in the
   side peek beside Threads; the narrow leg shrinks the window, which narrows
   the peek with it. */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-305");

let stack: Stack;
let conv: string;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await bootStack("ac305", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});
test.describe.configure({ mode: "serial" });

const panel = (page: Page) => page.locator("[data-thread-panel]");

/** The chat column: the conversation's own scroller port. */
const column = (page: Page) => panel(page).locator('[role="log"]').first();

const toolCards = (steps: Locator) =>
  steps.locator('[data-slot="collapsible"]');

/** The thread with the long-output turn settled, its steps block open and
    every tool card expanded. The first test starts the chat; later tests
    reopen the same thread through its URL. */
async function openStepsThread(page: Page): Promise<Locator> {
  await skipFirstRun(page);
  if (!conv) {
    conv = await startChat(
      page,
      stack.webUrl,
      { id: "default", name: "Default" },
      "longoutput: probe the relay",
    );
  } else {
    await page.goto(threadUrl(stack.webUrl, conv));
  }
  const turn = panel(page).locator("[data-agentturn]").last();
  await expectSettled(turn, 60_000);
  const steps = turn.locator("[data-tasksteps]").first();
  await expect(steps).toBeVisible({ timeout: 30_000 });
  /* A settled turn folds its steps to "N steps" unless the reader opened
     them — open the block when it came up folded. */
  if (!(await toolCards(steps).first().isVisible())) {
    await steps.locator("button").first().click();
  }
  await expect(toolCards(steps)).toHaveCount(5, { timeout: 15_000 });
  for (const card of await toolCards(steps).all()) {
    await card.locator("button").first().click();
  }
  /* The invariants below only mean something with the long tokens on screen:
     the one-line JSON from execute_code and the terminal's digest line. */
  await expect(toolCards(steps).nth(2)).toContainText('"execution_count":1');
  await expect(toolCards(steps).nth(4)).toContainText("SHA2-256(relay.tar)=");
  return steps;
}

/** Every tool card stays inside the column: nothing spills horizontally. */
async function expectCardsInside(steps: Locator) {
  for (const card of await toolCards(steps).all()) {
    await expect
      .poll(async () => card.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBe(0);
  }
}

const columnOverflowPx = (page: Page) =>
  column(page).evaluate((el) => el.scrollWidth - el.clientWidth);

test("AC-1..3,5: long unbroken output stays inside the card, wide + narrow", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
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
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
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
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1288, height: 700 });
  const steps = await openStepsThread(page);
  const out = toolCards(steps).nth(2);
  // Some box inside the card scrolls vertically within a bounded height.
  const bounded = await out.evaluate((el) =>
    [...el.querySelectorAll("div")].some(
      (x) => x.scrollHeight > x.clientHeight + 8 && x.clientHeight <= 280,
    ),
  );
  expect(bounded).toBe(true);
  await page.screenshot({ path: `${SHOTS}/ac-4-bounded.png` });
});
