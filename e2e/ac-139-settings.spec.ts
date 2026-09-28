import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/* ACs 1-4 (issue #139) — the prototype Settings screen: ⌘, or the sidebar gear
   opens it, every section carries mock data and working controls, Esc returns
   to the app, and it works at phone width. Saves one screenshot per section to
   test-results/ac139/ for the PR body. */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = join(REPO, "test-results", "ac139");

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Settings" });

test("AC-1 ⌘, and the sidebar gear open Settings", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");

  // Sidebar gear.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  for (const tab of ["General", "Approvals", "Editors", "Models", "Status", "About"]) {
    await expect(dialog.getByRole("tab", { name: tab })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // ⌘, (Control on Linux CI, Meta on macOS).
  await page.keyboard.press("Control+Comma");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-2 sections carry mock data and controls update mock state", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = settingsDialog(page);

  // General — rename Oscar; it lands in the sidebar footer after Close.
  await expect(dialog.getByLabel("Your name")).toHaveValue("Oscar");
  await dialog.getByLabel("Your name").fill("Ozzy");
  await dialog.getByLabel("Company name").fill("Oscar Industries");
  await dialog.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await dialog.getByRole("radio", { name: "System (follow macOS)" }).click();

  // Approvals — policy + default access switch.
  await dialog.getByRole("tab", { name: "Approvals" }).click();
  await dialog.getByRole("radio", { name: "Manual" }).click();
  await expect(
    dialog.getByRole("radio", { name: "Manual" }),
  ).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("radio", { name: "Full access" }).click();
  await expect(
    dialog.getByRole("radio", { name: "Full access" }),
  ).toHaveAttribute("aria-checked", "true");

  // Editors — pick a new default.
  await dialog.getByRole("tab", { name: "Editors" }).click();
  await dialog.getByRole("radio", { name: /Zed/ }).click();
  await expect(
    dialog.getByRole("radio", { name: /Zed/ }),
  ).toHaveAttribute("aria-checked", "true");

  // Models — the existing visibility dialog opens from here.
  await dialog.getByRole("tab", { name: "Models" }).click();
  await dialog.getByRole("button", { name: /Manage models/ }).click();
  const modelsDialog = page.getByRole("dialog", { name: "Models" });
  await expect(modelsDialog).toBeVisible();
  await modelsDialog.getByRole("switch", { name: "Show Qwen 3.8 Flash-Next" }).click();
  await expect(
    modelsDialog.getByRole("switch", { name: "Show Qwen 3.8 Flash-Next" }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(modelsDialog).not.toBeVisible();
  // Esc while a nested dialog is open must not close Settings itself.
  await expect(dialog).toBeVisible();

  // Status — the same legs as the status dialog.
  await dialog.getByRole("tab", { name: "Status" }).click();
  await expect(
    dialog.getByText("Connected · local relay on this Mac"),
  ).toBeVisible();
  await expect(dialog.getByText("Hermes 0.9 · ready")).toBeVisible();

  // About — version + check for updates.
  await dialog.getByRole("tab", { name: "About" }).click();
  await expect(dialog.getByText("0.1.0")).toBeVisible();
  await dialog.getByRole("button", { name: "Check for updates" }).click();
  await expect(dialog.getByText("up to date", { exact: false })).toBeVisible();

  // Close returns to the app; the renamed human shows in the sidebar footer.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("aside").getByText("Ozzy")).toBeVisible();
  await expect(page.locator("aside").getByText("Oscar Industries")).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-3 Esc returns to where Oscar was; phone width has no horizontal scroll", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  // Phone shell: open the nav drawer, tap the gear.
  await page.locator("main header button").first().click();
  await page
    .locator("aside")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();

  // Phone shows the section list first; tapping a section opens its pane.
  await expect(dialog.getByRole("tab", { name: "General" })).toBeVisible();
  await expect(dialog.getByLabel("Your name")).not.toBeVisible();
  await dialog.getByRole("tab", { name: "General" }).click();
  await expect(dialog.getByLabel("Your name")).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "phone-general.png") });

  // Back returns to the section list, then Close returns to the app.
  await dialog.getByRole("button", { name: "All settings" }).click();
  await expect(dialog.getByRole("tab", { name: "Status" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("how should the harness reconnect").first(),
  ).toBeVisible();

  // No horizontal scroll anywhere in the flow.
  const noHScroll = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    );
  expect(await noHScroll()).toBe(true);
  expect(errors).toEqual([]);
});

test("AC-4 a screenshot per section at 1288x700", async ({ page }) => {
  await page.setViewportSize({ width: 1288, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  for (const s of [
    "general",
    "approvals",
    "editors",
    "models",
    "status",
    "about",
  ]) {
    const label = s[0].toUpperCase() + s.slice(1);
    await dialog.getByRole("tab", { name: label }).click();
    await page.screenshot({ path: join(SHOTS, `${s}.png`) });
  }
});
