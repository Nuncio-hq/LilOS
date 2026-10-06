import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, type Stack } from "./helpers/stack";

/**
 * Issue #576 — Esc only ever CLOSES something; it never stops an employee's
 * work. A mount-ordered UI-layer stack owns the key (menu → dialog → panel
 * → Focus): the top-most surface takes the press and nothing underneath
 * reacts. ■ / ⌘. is the real stop shortcut — the composer's running hint
 * and the Stop button's tooltip both say so.
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

/** Open the app, land on Default's DM (dismissing the first-run card). */
async function dmDefault(stack: Stack, page: Page) {
  await page.goto(`${stack.webUrl}/`);
  const aside = page.locator("aside");
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
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

const send = async (page: Page, text: string) => {
  const box = page.locator("textarea").last();
  await box.fill(text);
  await box.press("Enter");
};

const STOPPED = "Stopped · session.interrupt";
/* #576 renamed the running hint to name the real stop shortcut. */
const RUNNING_HINT = /Enter (steers|queues) · ⌘\. stop/;

test("AC-576-1 Esc during a running turn never stops it — ⌘. does", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });

  /* Esc while typing in the composer pops the top layer (Focus → thread
     view) but stops nothing — the running hint is visible on both. */
  const box = page.locator("textarea").last();
  await box.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expect(page.getByText(RUNNING_HINT)).toBeVisible();
  await expect(page.getByText(STOPPED)).toHaveCount(0);

  // ⌘. is the same stop the ■ button calls.
  await page.keyboard.press("Meta+Period");
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac-1-cmd-dot-stopped.png` });
});

test("AC-576-2 Esc closes the top-most surface only — menu → dialog → Focus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  await expect(page.getByText(RUNNING_HINT)).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  /* Remember the conversation before Esc takes the URL back to /dm/<emp>. */
  const [emp, conv] = page
    .url()
    .split("/dm/")[1]
    .split("/")
    .map(decodeURIComponent);

  // Menu level: the model-picker popover eats the first Esc itself.
  await page.locator('[data-slot="model-picker-trigger"]').last().click();
  const pop = page.locator('[data-slot="popover-content"][data-open]');
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/focus$/); // Focus stayed open

  // Dialog level: Status opens over Focus; Esc closes only the dialog.
  await page.getByTitle("Back to DM").click();
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+$/);
  await page.getByRole("button", { name: "System status" }).click();
  const dialog = page.getByRole("dialog", { name: "System status" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-2-dialog-closed.png` });
  // The thread panel (under the dialog) is still on screen.
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+$/);

  // Panel level: the next Esc closes the thread panel back to the DM home.
  await page.keyboard.press("Escape");
  await page.waitForURL(/\/dm\/[^/]+$/);
  await page.screenshot({ path: `${SHOTS}/ac-2-panel-closed.png` });

  // The held turn kept running through every close — it was never stopped.
  await page.goto(`${stackA.webUrl}/dm/${emp}/${conv}/focus`);
  /* The held turn is still running after every close — the composer says
     "…is working. Enter steers this turn…" and nothing was interrupted. */
  await expect(
    page.getByPlaceholder(/is working\. Enter steers this turn/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(STOPPED)).toHaveCount(0);
});

test("AC-576-3 Esc closes every named dialog — Hire, Add folder, Pair phone, Status, Edit employee", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await dmDefault(stackA, page);

  // Hire employee (sidebar button).
  await page
    .locator("aside")
    .getByRole("button", { name: /hire employee/i })
    .click();
  const hire = page.getByRole("dialog", { name: "Hire an employee" });
  await expect(hire).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-hire-open.png` });
  await page.keyboard.press("Escape");
  await expect(hire).toHaveCount(0, { timeout: 15_000 });

  // Add a folder (composer chip → menu → Add a folder…).
  await page.locator('[data-ws="folder"]').click();
  await page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last()
    .getByText("Add a folder")
    .click();
  const folder = page.getByRole("dialog", { name: "Add a folder" });
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-addfolder-open.png` });
  /* The folder chip's menu can still be mounted under the dialog for a
     beat — while it is, it is the top-most surface and eats the first
     Esc, so a second one lands on the dialog. Either order is correct:
     Esc always unwinds only the top surface. */
  await page.keyboard.press("Escape");
  try {
    await expect(folder).toHaveCount(0, { timeout: 3_000 });
  } catch {
    await page.keyboard.press("Escape");
    await expect(folder).toHaveCount(0, { timeout: 15_000 });
  }

  // Pair phone (sidebar button; the dialog opens whatever its inner state).
  await page.getByRole("button", { name: "Pair phone" }).click();
  const pair = page.getByRole("dialog", { name: "Pair phone" });
  await expect(pair).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-pair-open.png` });
  await page.keyboard.press("Escape");
  await expect(pair).toHaveCount(0, { timeout: 15_000 });

  // System status (sidebar footer).
  await page.getByRole("button", { name: "System status" }).click();
  const status = page.getByRole("dialog", { name: "System status" });
  await expect(status).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-status-open.png` });
  await page.keyboard.press("Escape");
  await expect(status).toHaveCount(0, { timeout: 15_000 });

  // Edit employee: profile card first (a layer), Edit employee above it —
  // Esc unwinds them in order.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const card = page.getByRole("dialog", { name: /profile$/i });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card
    .getByRole("button", { name: /^Edit$/ })
    .first()
    .click();
  const edit = page.getByRole("dialog", { name: "Edit employee" });
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-edit-open.png` });
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0, { timeout: 15_000 });
  await expect(card).toBeVisible(); // only the top layer closed
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac-3-all-closed.png` });
});

test("AC-576-4 the Stop button's tooltip names ⌘. — not Esc", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dmDefault(stackA, page);
  await send(page, "LILOS_TURN_HOLD Add a release note to the readme");
  const stop = page.getByRole("button", { name: /stop/i });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(stop).toHaveAttribute("aria-label", /⌘\./);
  await expect(stop).toHaveAttribute("title", /⌘\./);
  await expect(stop).not.toHaveAttribute("aria-label", /Esc/);
  await page.screenshot({ path: `${SHOTS}/ac-4-stop-tooltip.png` });
});
