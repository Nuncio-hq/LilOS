import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The session view's Workbench has no header toggle: while it is hidden the
 * work strip under the title stands in for it (any tab on it opens the panel
 * on that tab), and once open the panel's own tab row takes over, closing
 * with its "Hide workbench". These helpers are the one place specs say so.
 */

/** The panel, shown (it is `display:none` while hidden, never unmounted). */
export const wbPanel = (page: Page): Locator =>
  page.locator("[data-wb-shell]:not(.hidden)");

/** The strip that reopens a hidden panel. */
export const workStrip = (page: Page): Locator =>
  page.locator("[data-work-strip]");

/** The panel's own close. */
export const hideWorkbench = (page: Page): Locator =>
  page.getByRole("button", { name: "Hide workbench" });

/** The Workbench is on offer: its panel open, or its strip waiting to open it.
 *  (A session with nothing to show offers neither.) */
export const workbenchOffered = (page: Page): Locator =>
  wbPanel(page).or(workStrip(page));

/**
 * Opens the Workbench if it is hidden, through the strip's own tab — Details
 * unless `tab` says otherwise (the one tab every session has). Opening is
 * idempotent: a panel that is already open stays as it is, so there is no
 * toggle to race against the open state seeding at mount.
 */
export async function openWorkbench(
  page: Page,
  tab = "details",
  timeout = 30_000,
) {
  await expect(workbenchOffered(page)).toBeVisible({ timeout });
  if (await wbPanel(page).isVisible()) return;
  await workStrip(page).locator(`[data-work-tab="${tab}"]`).click();
  await expect(wbPanel(page)).toBeVisible({ timeout });
}
