/**
 * The v3 status surfaces the live-chain specs (ac-33, ac-53) read: the banner
 * above every page (drawn only while a leg is down, reconnecting or degraded),
 * its Details dialog (System status), and Settings → Engine & models (the
 * Local relay + Engine rows and Copy diagnostics, inside the collapsed
 * Troubleshooting fold (#885) — `openTroubleshooting` reaches them).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { skipFirstRun } from "./stack";

/** A page on Threads that polls `system.status` every 500ms instead of 15s.
    `statusPollMs` is a real query param, so it rides ahead of the hash. */
export async function openPolled(page: Page, webUrl: string) {
  await skipFirstRun(page);
  await page.goto(`${webUrl}/?statusPollMs=500#?page=threads`);
}

/** The status banner (role=status carrying its Details action). */
export const banner = (page: Page): Locator =>
  page.getByRole("status").filter({ hasText: /Details/ });

/** The System status dialog, opened through the banner's Details. */
export async function openDetails(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "System status" });
  if (!(await dialog.isVisible().catch(() => false))) {
    await banner(page).getByRole("button", { name: "Details" }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

/** One leg's row in the dialog ("Relay", "Harness", "Engine", "Model"). */
export const leg = (dialog: Locator, label: string): Locator =>
  dialog
    .locator("div.flex.items-start")
    .filter({ has: dialog.page().getByText(label, { exact: true }) });

/** Settings → Engine & models, reached in-app: a hash change keeps the loaded
    page (a reload while the relay is down would re-boot into the loading
    gate). */
export async function openEnginePane(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    location.hash = "#?page=settings&view=engine";
  });
  const main = page.locator("main");
  await expect(
    main.locator("summary", { hasText: "Troubleshooting" }),
  ).toBeVisible({ timeout: 30_000 });
  return main;
}

/** The Troubleshooting fold, expanded when it stands closed (it already
    stands open while something it holds is failing). */
export async function openTroubleshooting(page: Page): Promise<Locator> {
  const main = page.locator("main");
  const details = main
    .locator("details")
    .filter({ hasText: "Troubleshooting" });
  await expect(details).toBeVisible({ timeout: 30_000 });
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", /.*/);
  }
  return main;
}

/** The "Local relay" row of Settings → Engine & models. */
const relayRow = (main: Locator): Locator =>
  main
    .getByText("Local relay", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");

/** The whole chain reads healthy: Settings shows the relay answering and the
    engine running, and the banner is gone. The model leg reads "engine
    running but no model reported" until the harness's first status report
    lands (~10s in), so the banner clearing is waited for, not assumed.
    Positive evidence, not just a missing banner (which is also what the boot
    gate looks like). */
export async function expectHealthy(page: Page) {
  await openEnginePane(page);
  const main = await openTroubleshooting(page);
  await expect(relayRow(main)).toContainText("Connected", { timeout: 60_000 });
  await expect(main.getByText("Running", { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(banner(page)).toHaveCount(0, { timeout: 60_000 });
}

/** What a Copy diagnostics click put on the clipboard. Needs
    `clipboard-read` + `clipboard-write` granted on the context. */
export const clipboard = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());
