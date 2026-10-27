import { expect, test } from "@playwright/test";

/* #870 evidence on the prototype's mock company (webServer → prototype/web).
   Screenshots land in test-results/v3-add-agent/proto-*.png and get uploaded
   to pr-assets-871. */
const shots = "test-results/v3-add-agent";

async function openDialog(page: import("@playwright/test").Page) {
  await page.goto("/");
  /* Under ~700px the sidebar is hidden behind ☰ (#886): pop it over the
     page first — the ＋ is a row of that sidebar. */
  const show = page
    .locator("[data-sidebar-shortcuts]")
    .getByRole("button", { name: "Show sidebar" });
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
  await page.getByRole("button", { name: "Add agent" }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Name", { exact: true })).toBeVisible();
  return dlg;
}

test.describe("prototype evidence (#870)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`add-agent dialog — ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1288, height: 900 });
      await page.goto(`/?theme=${theme}`);
      const dlg = await openDialog(page);
      await expect(dlg.getByLabel("Name")).toHaveValue(/.+/);
      await page.screenshot({ path: `${shots}/proto-add-agent-${theme}.png` });
    });
  }

  test("add-agent dialog — phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?theme=light");
    const dlg = await openDialog(page);
    await expect(dlg.getByLabel("Name")).toHaveValue(/.+/);
    await page.screenshot({ path: `${shots}/proto-add-agent-phone.png` });
  });
});
