import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * Issue #577 — where a new message lands and the way back (decided with
 * Oscar 2026-10-07): a new send STAYS on the DM list with the thread open
 * in the side panel, like the prototype — no jump to Focus. Focus opens
 * only when Oscar asks (the panel's ↗). The panel gets a visible ✕ back
 * to the DM list, the header panel icon is a labelled toggle, and Focus
 * has ONE back control whose label matches where it goes.
 *
 *   AC-1 a new send and opening a session land in the same view — the DM
 *       list with the thread panel; never a straight jump to Focus.
 *   AC-2 the panel has a visible ✕ that returns to the DM list; the
 *       header icon is labelled and toggles the panel.
 *   AC-3 Focus has one back control whose label matches where it goes
 *       ("Back to DM" → the DM view with the panel).
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-577");

const PANEL_URL = /\/dm\/[^/]+\/conv_[^/]+$/;
const DM_URL = /\/dm\/[^/]+$/;
const FOCUS_URL = /\/dm\/[^/]+\/conv_[^/]+\/focus$/;

let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("ac577", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

async function dmDefault(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  await aside
    .getByRole("button", { name: /default/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/dm\//, { timeout: 30_000 });
}

const send = async (page: Page, text: string) => {
  /* The DM-home composer — `main` is the EmployeeHome feed; the thread
     panel's own composer lives outside it. */
  const box = page.locator("main textarea").first();
  await box.fill(text);
  await box.press("Enter");
};

const panel = (page: Page) => page.locator("[data-thread-panel]");

test("AC-1 a new send lands on the DM list with the thread in the panel — no jump to Focus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, "hello — where do I land");
  /* The panel URL, not /focus: the DM list is still the page behind it. */
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(panel(page)).toBeVisible();
  await expect(
    panel(page).getByText("hello — where do I land").first(),
  ).toBeVisible({ timeout: 15_000 });
  /* …and the DM list itself never left — the feed rows sit beside the
     panel, exactly like the prototype. */
  await expect(
    page.locator("main").getByText("hello — where do I land").first(),
  ).toBeVisible({ timeout: 15_000 });
  // The turn renders in the panel — the reply shows where the user reads.
  await expect(panel(page).locator("[data-agentturn]").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${SHOTS}/ac-1-send-in-panel.png` });

  /* Opening an existing session lands in the SAME view: back to the list,
     click the session row — panel again, still not /focus. */
  await page.locator("[data-panel-toggle]").click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });
  await page.locator("[data-session] button").last().click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  expect(page.url()).not.toMatch(/\/focus/);
  await page.screenshot({ path: `${SHOTS}/ac-1-open-same-view.png` });
});

test("AC-2 the panel's ✕ and the labelled header toggle are the ways back to the DM list", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, "close me twice");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });
  await expect(panel(page)).toBeVisible();

  /* ✕ on the panel → back to the plain DM list (no conversation open). */
  await panel(page).getByLabel("Close thread panel").click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-closed.png` });

  /* The header toggle is labelled ("Panel", not a bare icon) and pressed
     while the panel is open. */
  const toggle = page.locator("[data-panel-toggle]");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("Panel");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  // …it re-opens the latest thread — same session back in the panel.
  await toggle.click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-toggle.png` });
  // …and toggles it shut — same affordance, both directions.
  await toggle.click();
  await expect(page).toHaveURL(DM_URL, { timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
});

test("AC-3 Focus has one back control, labelled for where it goes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(page);
  await send(page, "take me to focus and back");
  await expect(page).toHaveURL(PANEL_URL, { timeout: 30_000 });

  /* Focus opens only when asked — the panel's ↗ is the one door in. */
  await panelIntoFocus(page);
  await expect(page).toHaveURL(FOCUS_URL);
  // One way out: a single back control saying where it lands.
  const back = page.getByRole("button", { name: "Back to DM" });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await expect(back).toHaveCount(1);
  // The old affordances are gone — no second way out to learn.
  await expect(page.getByTitle("Exit focus")).toHaveCount(0);
  /* …and in the header it is the only go-back affordance (accessible
     name, since the visible span just says "DM"). */
  await expect(
    page
      .locator("main header")
      .getByRole("button", { name: /back|exit|close/i }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/ac-3-one-back.png` });

  /* "Back to DM" lands on the DM view the send left — the list with the
     thread still open beside it — not a third, unnamed view. */
  await back.click();
  await expect(page).toHaveURL(PANEL_URL, { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac-3-back-to-dm.png` });
});
