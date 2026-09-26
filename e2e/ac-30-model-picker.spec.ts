import { expect, type Page, test } from "@playwright/test";

/* Issue #30: the composer model picker. AC-1 the list is the engine's models.list answer,
   grouped by provider (prototype: MODELS stands in for the catalog). AC-2 the pick applies
   to the NEXT turn: the reply footer shows the model the engine stamped on turn.started.
   AC-3 an engine without the `models` capability (prototype: `?models=off`) renders no
   picker at all. Console errors must be 0. */

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function sendDM(page: Page, text: string) {
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Builder/ })
    .click();
  const box = page.getByPlaceholder(/New session with Builder/);
  await box.fill(text);
  await box.press("Enter");
}

/* The picker trigger in the thread composer shows the current model's name. */
const trigger = (page: Page, name: RegExp) =>
  page.getByRole("button", { name });

test("AC-1 picker lists engine models grouped by provider", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "Check the relay reconnect plan");
  await trigger(page, /Qwen 3\.8 Flash-Next/).click();
  // One group per provider, every catalog row listed under its group.
  for (const provider of ["alibaba", "anthropic", "openai", "cognition"]) {
    await expect(
      page.locator("[cmdk-group-heading]", { hasText: provider }),
    ).toBeVisible();
  }
  const group = (provider: string) =>
    page.getByRole("group", { name: provider });
  await expect(group("alibaba").getByText(/Flash-Next/)).toBeVisible();
  await expect(group("anthropic").getByText(/Opus 5\.5/)).toBeVisible();
  await expect(group("openai").getByText(/GPT-5\.5/)).toBeVisible();
  await expect(group("cognition").getByText(/Devin/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("AC-2 the next turn runs on the picked model (turn metadata)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await sendDM(page, "What's the state of the relay package?");
  // Turn 1 finishes on the employee's default model — the footer shows it.
  await expect(page.getByText(/· qwen3\.8-flash-next/).first()).toBeVisible({
    timeout: 60_000,
  });
  await trigger(page, /Qwen 3\.8 Flash-Next/).click();
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  // The pick acks on the thread and the trigger now shows it.
  await expect(trigger(page, /GPT-5\.5 · subscription/)).toBeVisible();
  // A fresh prompt (turn 2) now runs on the picked model.
  const box = page.getByPlaceholder(/Reply to Builder/);
  await box.fill("and the harness?");
  await box.press("Enter");
  // turn.started.model lands on the finished turn's footer: "· gpt-5.5".
  await expect(page.getByText(/· gpt-5\.5/).first()).toBeVisible({
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
  await expect(
    page.getByRole("button", {
      name: /Select model|Flash-Next|Opus|GPT-5\.5|AgentAuth/,
    }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
