import { expect, type Page, test } from "@playwright/test";

/* Issue #30 + model picker v2 (Codex-style). AC-1 the list is the engine's models.list
   answer grouped by provider — the dev server's `/api/engine` runs a real engine-fake, so
   its "Fake" group sits beside the mock Hermes catalog. AC-2 the pick applies to the NEXT
   turn: the reply footer shows the model the engine stamped on turn.started. AC-3 an engine
   without the `models` capability (prototype: `?models=off`) renders no picker at all.
   v2: the new-session composer picks model + effort + fast before the session exists; the
   slider shows only the chosen model's levels; Edit models hides a provider for every
   employee. Console errors must be 0. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const openBuilder = (page: Page) =>
  page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();

async function sendDM(page: Page, text: string) {
  await openBuilder(page);
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

/* Composer triggers: [0] = new-session composer (employee home), last = the open thread. */
const triggers = (page: Page) =>
  page.locator('[data-slot="model-picker-trigger"]');
/* Open a trigger's popover and drill into the model list. */
async function openModelList(page: Page, which: "first" | "last") {
  await triggers(page)[which]().click();
  await page.getByRole("button", { name: /Model$/ }).click();
}
const option = (page: Page, name: string) =>
  page.locator("[cmdk-item]", {
    hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("lilos-model-visibility"));
});

test("AC-1 picker lists engine models grouped by provider", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Check the relay reconnect plan");
  await openModelList(page, "last");
  // The live catalog (engine-fake via /api/engine) lands under its provider group,
  // beside the Hermes-shaped providers (engine-named groups).
  const fake = page.getByRole("group", { name: "Fake", exact: true });
  await expect(fake).toBeVisible();
  await expect(fake.getByText("Fake Small")).toBeVisible();
  await expect(fake.getByText("Fake Reasoning")).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Anthropic – CLIProxyAPI" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-2 the next turn runs on the picked model (turn metadata)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "What's the state of the relay package?");
  // Turn 1 runs on the employee default: model · its default effort.
  await expect(
    page.getByText("· Qwen 3.8 Flash-Next · Medium").first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await openModelList(page, "last");
  await option(page, "Fake Reasoning").click();
  await page.keyboard.press("Escape");
  await expect(triggers(page).last()).toContainText("Fake Reasoning");
  const box = page.getByPlaceholder(/Reply to Builder/);
  await box.fill("and the harness?");
  await box.press("Enter");
  await expect(page.getByText("· Fake Reasoning").first()).toBeVisible({
    timeout: 60_000,
  });
  expect(errors).toEqual([]);
});

test("AC-3 no picker when the engine lacks the models capability", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const errors = watchConsole(page);
  await page.goto("/?models=off");
  await sendDM(page, "Check the relay reconnect plan");
  // No trigger anywhere — no placeholder control, no disabled shell (D-#19).
  await expect(triggers(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("v2 new session: pick model + effort + fast first; the next new session starts on the employee default", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await openBuilder(page);
  const home = triggers(page).first();
  await expect(home).toContainText("Qwen 3.8 Flash-Next");
  await expect(home).toContainText("Medium");
  // Qwen reports no per-model list → the full Hermes ladder (7 steps).
  await home.click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  await expect(slider).toHaveAttribute("max", "6");
  // No per-level tick buttons: you drag (Codex-style).
  await expect(page.getByRole("button", { name: "Ultra" })).toHaveCount(0);
  await page.getByRole("button", { name: /Model$/ }).click();
  await option(page, "GPT-6 Astra").click();
  // Astra reports its own levels: Low … Max (5 steps).
  await expect(slider).toHaveAttribute("max", "4");
  await page.getByRole("button", { name: "Fast mode" }).click();
  // Drag the thumb from Medium to the Extra-high stop (index 3 of 0..4).
  const box0 = await page
    .locator('[data-slot="effort-fill"]')
    .locator("..")
    .boundingBox();
  if (!box0) throw new Error("no effort track");
  const x = (i: number) => box0.x + 11 + ((box0.width - 22) * i) / 4;
  const y = box0.y + box0.height / 2;
  await page.mouse.move(x(1), y);
  await page.mouse.down();
  await page.mouse.move(x(2), y, { steps: 5 });
  await page.mouse.move(x(3), y, { steps: 5 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute("aria-valuetext", "Extra high");
  await page.keyboard.press("Escape");
  await expect(home).toContainText("GPT-6 Astra");
  await expect(home).toContainText("Extra high");

  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill("Check the relay reconnect plan");
  await box.press("Enter");
  await expect(
    page.getByText("· GPT-6 Astra · Extra high · Fast").first(),
  ).toBeVisible({ timeout: 60_000 });
  // The session keeps its pick; the new-session composer is back on the default.
  await expect(triggers(page).last()).toContainText("GPT-6 Astra");
  await expect(triggers(page).first()).toContainText("Qwen 3.8 Flash-Next");
  expect(errors).toEqual([]);
});

test("v2 a model without reasoning control shows no slider", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await openBuilder(page);
  await openModelList(page, "first");
  await option(page, "Claude 3.5 Haiku").click();
  await expect(
    page.getByText("This model has no reasoning control."),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("v2 Edit models hides a provider for every employee; Refresh adds new models", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await openBuilder(page);
  await openModelList(page, "first");
  await page.getByRole("option", { name: /Refresh models/ }).click();
  await expect(page.getByText("Models refreshed · 1 new model")).toBeVisible();
  await expect(option(page, "Claude Opus 5.6 (new)")).toHaveCount(1);
  await page.getByRole("option", { name: /Edit models/ }).click();
  const dialog = page.getByRole("dialog", { name: "Models" });
  await dialog.getByRole("checkbox", { name: /Show all xAI/ }).click();
  await expect(dialog.getByText("0/3")).toBeVisible();
  await page.keyboard.press("Escape");
  // Another employee's picker: the xAI group is gone.
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Reviewer/ })
    .click();
  await openModelList(page, "first");
  await expect(page.getByRole("group", { name: /xAI Grok/ })).toHaveCount(0);
  await expect(option(page, "GPT-6 Astra")).toHaveCount(1);
  expect(errors).toEqual([]);
});
