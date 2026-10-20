import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  panelIntoFocus,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #577 — where a new message lands and the way back (decided with
 * Oscar 2026-10-07): a new send STAYS on the list with the thread open
 * in the side panel, like the prototype — no jump to Focus. Focus opens
 * only when Oscar asks (widen the peek, or the panel's Focus button). The
 * panel gets a visible ✕ back to the list, the trail's first crumb names
 * where it returns to, and Focus has ONE back control whose label matches
 * where it goes.
 *
 *   AC-1 a new send and opening a thread land in the same view — the list
 *       with the thread panel; never a straight jump to Focus.
 *   AC-2 the panel has a visible ✕ that returns to the list; the trail's
 *       "Threads" crumb is the labelled way back too.
 *   AC-3 Focus has one back control whose label matches where it goes
 *       ("Back to DM" → the thread beside the list).
 *
 * v3: the list is the Threads page, the panel is the side peek
 * (`#?page=threads&open=thread:<id>`) and Focus is the widened peek
 * (`&full=1`). The old header "Panel" toggle that re-opened the latest
 * thread has no v3 control: a thread is re-opened from its row.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-577");

const PANEL_URL = /page=threads&open=thread:conv_[^&]+$/;
const LIST_URL = /page=threads$/;
const FOCUS_URL = /page=threads&open=thread:conv_[^&]+&full=1$/;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac577", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const panel = (page: Page) => page.locator("[data-thread-panel]");

/** The thread's own row/card on the Threads page beside the panel. */
const listRow = (page: Page, text: RegExp) =>
  page.locator("#v3-main").getByText(text).first();

test("AC-1 a new send lands on the list with the thread in the panel — no jump to Focus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "hello — where do I land");
  /* The panel URL, not full=1: the Threads list is still the page behind it. */
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(panel(page)).toBeVisible();
  await expect(
    panel(page).getByText("hello — where do I land").first(),
  ).toBeVisible({ timeout: 15_000 });
  /* …and the list itself never left — the thread's card sits beside the
     panel, exactly like the prototype. */
  await expect(listRow(page, /where do I land/i)).toBeVisible({
    timeout: 15_000,
  });
  // The turn renders in the panel — the reply shows where the user reads.
  await expect(panel(page).locator("[data-agentturn]").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-send-in-panel.png` });

  /* Opening an existing thread lands in the SAME view: back to the list,
     click the thread's row — panel again, still not full. */
  await v3Peek(page).getByTitle("Close (Esc)").click();
  await expect(page).toHaveURL(LIST_URL, { timeout: 15_000 });
  await listRow(page, /where do I land/i).click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  expect(page.url()).not.toMatch(/full=1/);
  await page.screenshot({ path: `${SHOTS}/ac-1-open-same-view.png` });
});

test("AC-2 the panel's ✕ and the labelled trail crumb are the ways back to the list", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "close me twice");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(panel(page)).toBeVisible();

  /* ✕ on the panel → back to the plain list (no thread open). */
  await v3Peek(page).getByTitle("Close (Esc)").click();
  await expect(page).toHaveURL(LIST_URL, { timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-closed.png` });

  /* The thread is re-opened from its row… */
  await listRow(page, /close me twice/i).click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-reopened.png` });

  /* …and the trail's first crumb is labelled with where it goes back to
     ("Threads", not a bare icon): it shuts the panel the same way. */
  const crumb = v3Peek(page)
    .getByRole("navigation", { name: "Trail" })
    .getByRole("button", { name: "Threads" });
  await expect(crumb).toBeVisible();
  await crumb.click();
  await expect(page).toHaveURL(LIST_URL, { timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
});

test("AC-3 Focus has one back control, labelled for where it goes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "take me to focus and back");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });

  /* Focus opens only when asked — widening is the one door in. */
  await panelIntoFocus(page);
  await expect(page).toHaveURL(FOCUS_URL);
  // One way out of the session view itself: a single back control saying
  // where it lands.
  const back = page.getByRole("button", { name: "Back to DM" });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await expect(back).toHaveCount(1);
  // The old affordances are gone — no second way out to learn.
  await expect(page.getByTitle("Exit focus")).toHaveCount(0);
  /* …and inside the session view it is the only go-back affordance
     (accessible name, since the visible span just says "Default"). */
  await expect(
    panel(page).getByRole("button", { name: /back|exit|close/i }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-3-one-back.png` });

  /* "Back to DM" lands on the view the send left — the list with the
     thread still open beside it — not a third, unnamed view. */
  await back.click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-3-back-to-dm.png` });
});
