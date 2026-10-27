import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  panelIntoFocus,
  panelOutOfFocus,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  threadUrl,
  v3Peek,
} from "./helpers/stack";

/**
 * Issue #576 — Esc only ever CLOSES something; it never stops an employee's
 * work. A mount-ordered UI-layer stack owns the key (menu → dialog → panel
 * → Focus): the top-most surface takes the press and nothing underneath
 * reacts. ■ / ⌘. is the real stop shortcut — the composer's running hint
 * and the Stop button's tooltip both say so.
 *
 * v3: the panel is the side peek (`open=thread:<id>`), Focus is the widened
 * peek (`full=1`); Esc walks session → thread → closed. Of the old dialogs
 * the ones still dialogs are Search (⌘K), the shortcut list (⌘/), "Add a
 * folder" (the thread header's link) and System status (the banner's
 * Details); Hire and Pair phone are pages now and Edit employee is gone.
 *
 * One stack, serial tests — `LILOS_TURN_HOLD` parks a turn mid-run so Esc
 * can be pressed at a provably-running turn.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac-576");

let stackA: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stackA = await bootStack("esc", await pickPorts());
});
test.afterAll(async () => {
  await stackA?.stop();
});

test.describe.configure({ mode: "serial" });

/* #585 stripped the wire name from the turn chip — it renders "Stopped"
   plain now (anchored so the lowercase "stopped" row word and the
   "Stopped." sysnote don't match). */
const STOPPED = /^Stopped$/;
/* A turn is running while its ■ Stop (⌘.) is on the composer — the old
   "Enter steers · ⌘. stop" hint is gone (#886). Named by its exact label:
   a "stopped" thread row also matches /stop/i. */
const runningStop = (p: import("@playwright/test").Page) =>
  p
    .getByRole("button", { name: /^stop \(⌘\.\)$/i })
    .filter({ visible: true })
    .first();

/** A turn parked mid-run in a thread opened beside Threads. */
const startHeldTurn = async (page: Page) => {
  const agent = await openDefaultAgent(page, stackA.webUrl);
  return startChat(
    page,
    stackA.webUrl,
    agent,
    "LILOS_TURN_HOLD Add a release note to the readme",
  );
};

test("AC-576-1 Esc during a running turn never stops it — ⌘. does", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startHeldTurn(page);
  await expect(runningStop(page)).toBeVisible({ timeout: 30_000 });
  /* #577: hop into Focus — Esc pops it back onto the thread panel (the hint
     stays mounted); on the panel itself Esc closes the panel — also true,
     but this AC is about the turn surviving. */
  await panelIntoFocus(page);

  /* Esc while typing in the composer pops the top layer (Focus → thread
     view) but stops nothing — the running hint is visible on both. */
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/full=1/);
  await page.waitForTimeout(400);
  await expect(runningStop(page)).toBeVisible();
  await expect(page.getByText(STOPPED)).toHaveCount(0);

  // ⌘. is the same stop the ■ button calls.
  await page.keyboard.press("Meta+Period");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-cmd-dot-stopped.png` });
});

test("AC-576-2 Esc closes the top-most surface only — menu → dialog → thread → closed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const conv = await startHeldTurn(page);
  await expect(runningStop(page)).toBeVisible({ timeout: 30_000 });
  // #577: send lands on the panel — hop to Focus for the layer walk.
  await panelIntoFocus(page);

  // Menu level: the model-picker popover eats the first Esc itself.
  await page.locator('[data-slot="model-picker-trigger"]').last().click();
  const pop = page.locator('[data-slot="popover-content"][data-open]');
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0, { timeout: 15_000 });
  await expect(page).toHaveURL(/full=1$/); // Focus stayed open

  // Dialog level: the shortcut list opens over the thread; Esc closes only
  // the dialog.
  await panelOutOfFocus(page);
  await expect(page).toHaveURL(/open=thread:[^&]+$/);
  await page.keyboard.press("Meta+/");
  const dialog = page.locator("[data-shortcuts-dialog]");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-dialog-closed.png` });
  // The thread panel (under the dialog) is still on screen.
  await expect(page).toHaveURL(/open=thread:[^&]+$/);
  await expect(page.locator("[data-thread-panel]")).toBeVisible();

  // Panel level: the next Esc closes the thread panel back to the list.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/page=threads$/);
  await expect(v3Peek(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-closed.png` });

  // The held turn kept running through every close — it was never stopped.
  await page.goto(threadUrl(stackA.webUrl, conv, true));
  /* The held turn is still running after every close — the composer says
     "Message X… it reads this at the next step" and nothing was interrupted. */
  await expect(
    page.getByPlaceholder(/it reads this at the next step/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(STOPPED)).toHaveCount(0);
});

test("AC-576-3 Esc closes every named dialog — Search, shortcuts, Add a folder, Status", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await startHeldTurn(page);
  await expect(page.locator("[data-thread-panel]")).toBeVisible();

  // Search (⌘K).
  await page.keyboard.press("Meta+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-search-open.png` });
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0, { timeout: 15_000 });
  // Only the top layer closed: the thread is still open beside the list.
  await expect(page.locator("[data-thread-panel]")).toBeVisible();

  // Add a folder (the folder-less thread's header link).
  await page.locator("[data-add-folder]").click();
  const folder = page.getByRole("dialog", { name: "Add a folder" });
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-addfolder-open.png` });
  await page.keyboard.press("Escape");
  await expect(folder).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-thread-panel]")).toBeVisible();

  // The shortcut list (⌘/).
  await page.keyboard.press("Meta+/");
  const shortcuts = page.locator("[data-shortcuts-dialog]");
  await expect(shortcuts).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-shortcuts-open.png` });
  await page.keyboard.press("Escape");
  await expect(shortcuts).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-all-closed.png` });

  /* System status (the banner's Details). The banner is drawn only while a
     leg is down, so this leg boots an engine that cannot start — the same
     dead-engine shape the #85/#589 e2e drive. */
  const dead = await bootStack("escdead", await pickPorts(), {
    LILOS_ENGINE: "hermes",
    HERMES_BIN: "/nonexistent/hermes-bin",
  });
  try {
    await skipFirstRun(page);
    await page.goto(`${dead.webUrl}/`);
    await page
      .getByRole("status")
      .getByRole("button", { name: "Details" })
      .click({ timeout: 90_000 });
    const status = page.getByRole("dialog", { name: "System status" });
    await expect(status).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/ac-3-status-open.png` });
    await page.keyboard.press("Escape");
    await expect(status).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await dead.stop();
  }
});

test("AC-576-4 the Stop button's tooltip names ⌘. — not Esc", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startHeldTurn(page);
  /* A thread row whose word is "stopped" also matches /stop/i — name the
     button by its exact aria-label. */
  const stop = page.getByRole("button", { name: /^stop \(⌘\.\)$/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toHaveAttribute("aria-label", /⌘\./);
  await expect(stop).toHaveAttribute("title", /⌘\./);
  await expect(stop).not.toHaveAttribute("aria-label", /Esc/);
  await page.screenshot({ path: `${SHOTS}/ac-4-stop-tooltip.png` });
});
