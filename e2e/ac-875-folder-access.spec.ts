import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Screenshot evidence for #875: the folder-access ask step and the denied
 * banner, light and dark, at 1288x900 against the prototype's `?fa=` mock
 * surfaces. PNGs land in test-results/evidence/folder-access/<theme>/.
 * Each shot is checked for size the moment it is written — Playwright wipes
 * test-results/ at the start of every run.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/
const repo = path.resolve(here, "..");
const OUT = path.join(repo, "test-results", "evidence", "folder-access");

for (const theme of ["light", "dark"] as const) {
  test(`#875 folder access surfaces — ${theme}`, async ({ page }) => {
    const dir = path.join(OUT, theme);
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width: 1288, height: 900 });

    const shot = async (name: string) => {
      const file = path.join(dir, `${name}.png`);
      await page.screenshot({ path: file });
      expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(
        10_000,
      );
    };

    // The ask step: explains why before the OS prompt appears.
    await page.goto(`/?fa=ask&theme=${theme}`);
    await expect(
      page.getByRole("dialog", { name: "Folder access" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Allow access" }),
    ).toBeVisible();
    await shot("folder-access-step");

    // The denied banner: names the folder, offers System Settings.
    await page.goto(`/?fa=blocked&theme=${theme}`);
    await expect(
      page.getByText(/can't read files in your Desktop folder/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /system settings/i }),
    ).toBeVisible();
    /* The page's 0.25s lilos-v3-line-in fade must finish first — the shot
       otherwise catches it mid-fade (review round 1, should-fix 10). */
    await page.waitForTimeout(400);
    await shot("folder-access-banner");
  });
}
