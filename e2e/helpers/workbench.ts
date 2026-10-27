import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The session view's Workbench has no header toggle: while it is hidden the
 * header's ⋯ menu stands in for it (#886 — the icon strip's tabs live there
 * as labeled rows; a row opens the panel on that surface), and once open
 * the panel's own tab row takes over, closing with its "Hide workbench".
 * These helpers are the one place specs say so.
 */

/** The panel, shown (it is `display:none` while hidden, never unmounted). */
export const wbPanel = (page: Page): Locator =>
  page.locator("[data-wb-shell]:not(.hidden)");

/** The header's ⋯ — the work surfaces' home while the panel is hidden.
 *  visible+.first(): the peek header and the scrolled sticky bar can both
 *  carry the button — they open the same menu; click the one on screen. */
export const workMenu = (page: Page): Locator =>
  page
    .locator(
      '[data-thread-header] [aria-label="Thread actions"], [data-thread-bar] [aria-label="Thread actions"]',
    )
    .filter({ visible: true })
    .first();

/** The labeled rows inside that menu — the old strip, kept for selectors. */
export const workStrip = (page: Page): Locator =>
  page.locator("[data-work-strip]");

/** The panel's own close. */
export const hideWorkbench = (page: Page): Locator =>
  page.getByRole("button", { name: "Hide workbench" });

/** The Workbench is on offer: its panel open, or the ⋯ menu that opens it.
 *  (A session with nothing to show offers neither.) `.first()`: the panel
 *  and a peek header's ⋯ are often both on screen — either proves it. */
export const workbenchOffered = (page: Page): Locator =>
  wbPanel(page).or(workMenu(page)).first();

/**
 * Opens the Workbench if it is hidden, through the ⋯ menu's labeled row —
 * Details unless `tab` says otherwise (the one surface every session has).
 * Opening is idempotent: a panel that is already open stays as it is, so
 * there is no toggle to race against the open state seeding at mount.
 */
export async function openWorkbench(
  page: Page,
  tab = "details",
  timeout = 30_000,
) {
  await expect(workbenchOffered(page)).toBeVisible({ timeout });
  if (await wbPanel(page).isVisible()) return;
  await workMenu(page).click();
  await workStrip(page).locator(`[data-work-tab="${tab}"]`).click();
  await expect(wbPanel(page)).toBeVisible({ timeout });
}
