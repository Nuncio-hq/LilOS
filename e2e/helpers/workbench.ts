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

/** The header's ⋯ that holds the work surfaces — the ones marked
 *  `data-work-menu`, not the ⋯ every thread has for Rename/Done/Pin (that
 *  one is on screen regardless and proves nothing about the Workbench). It is
 *  only marked while the panel is hidden and there is a surface to open.
 *  visible+.first(): the peek header and the scrolled sticky bar can both
 *  carry the button — they open the same menu; click the one on screen. */
export const workMenu = (page: Page): Locator =>
  page
    .locator(
      "[data-thread-header] [data-work-menu], [data-thread-bar] [data-work-menu]",
    )
    .filter({ visible: true })
    .first();

/** The header's named "Changes" button — drawn only while files changed, and
 *  never a row of the ⋯ menu (`[data-work-strip]` rows are the others). */
export const changesButton = (page: Page): Locator =>
  page
    .locator(
      '[data-thread-header] button[data-work-tab="changes"], [data-thread-bar] button[data-work-tab="changes"]',
    )
    .filter({ visible: true })
    .first();

/** The labeled rows inside that menu — the old strip, kept for selectors. */
export const workStrip = (page: Page): Locator =>
  page.locator("[data-work-strip]");

/** The panel's own close. */
export const hideWorkbench = (page: Page): Locator =>
  page.getByRole("button", { name: "Hide workbench" });

/** The Workbench is on offer: its panel open, or a header control that
 *  opens it — the ⋯ with work rows, or the Changes button. (A session with
 *  nothing to show offers none of them: the plain ⋯ does not count.)
 *  `.first()`: several can be on screen — any one proves it. */
export const workbenchOffered = (page: Page): Locator =>
  wbPanel(page).or(workMenu(page)).or(changesButton(page)).first();

/**
 * Opens the Workbench if it is hidden — through the ⋯ menu's labeled row,
 * Details unless `tab` says otherwise (the one surface every session has).
 * `tab: "changes"` takes the header's Changes button when files changed;
 * Changes is never a ⋯ row, so a session without changes opens on Details,
 * where the panel's own tab row has it. Opening is idempotent: a panel that
 * is already open stays as it is, so there is no toggle to race against the
 * open state seeding at mount.
 */
export async function openWorkbench(
  page: Page,
  tab = "details",
  timeout = 30_000,
) {
  await expect(workbenchOffered(page)).toBeVisible({ timeout });
  if (await wbPanel(page).isVisible()) return;
  if (tab === "changes" && (await changesButton(page).isVisible())) {
    await changesButton(page).click();
  } else {
    await workMenu(page).click();
    await workStrip(page)
      .locator(`[data-work-tab="${tab === "changes" ? "details" : tab}"]`)
      .click();
  }
  await expect(wbPanel(page)).toBeVisible({ timeout });
}
