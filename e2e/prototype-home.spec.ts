import { expect, test } from "@playwright/test";

test("prototype home renders the company sidebar", async ({ page }) => {
  await page.goto("/");
  // The prototype's shell: sidebar + main pane with some visible content.
  await expect(page).toHaveTitle(/LilOS/i);
  await expect(page.locator("body")).toContainText("LilOS");
  await page.screenshot({
    path: "test-results/prototype-home.png",
    fullPage: false,
  });
});
